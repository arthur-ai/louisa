import {
  getCommitsBetweenTags,
  getMergeRequestsForCommits,
  getPreviousReleaseTag,
  getReleaseByTag,
  createRelease,
  getProjectUrl,
} from "../lib/gitlab.js";
import { generatePlatformReleaseNotes } from "../lib/claude-platform.js";
import { postReleaseToSlack } from "../lib/slack.js";
import { getTracer, forceFlush, activeSpan } from "../lib/otel.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify GitLab webhook token
  const token = req.headers["x-gitlab-token"];
  if (token !== process.env.GITLAB_WEBHOOK_SECRET) {
    console.warn("Louisa: invalid GitLab webhook token");
    return res.status(401).json({ error: "Invalid token" });
  }

  const payload   = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const eventType = payload.object_kind || payload.event_name;

  // Only handle tag push events
  if (eventType !== "tag_push" && eventType !== "push") {
    return res.status(200).json({ skipped: true, reason: `event=${eventType}` });
  }

  // For push events, only handle tags
  const ref = payload.ref || "";
  if (!ref.startsWith("refs/tags/")) {
    return res.status(200).json({ skipped: true, reason: "not a tag" });
  }

  // Skip tag deletions
  if (payload.after === "0000000000000000000000000000000000000000") {
    return res.status(200).json({ skipped: true, reason: "tag deleted" });
  }

  const tag       = ref.replace("refs/tags/", "");
  const projectId = payload.project_id || process.env.GITLAB_PROJECT_ID;

  console.log(`Louisa: GitLab tag detected — ${tag} (project ${projectId})`);

  // Only generate release notes for successful production platform deployments.
  // Expected format: {version}-success-aws-prod-platform (e.g. 1.4.1892-success-aws-prod-platform)
  if (!tag.endsWith("-success-aws-prod-platform")) {
    console.log(`Louisa: skipping non-production tag ${tag}`);
    return res.status(200).json({ skipped: true, reason: "non-production tag" });
  }

  // Initialise the OTel provider (+ Anthropic auto-instrumentation) once per container.
  const tracer = getTracer();

  try {
    const result = await activeSpan(tracer, "louisa.gitlab.release", {
      "openinference.span.kind": "CHAIN",
      "agent.name":              "Louisa",
      "input.value":             JSON.stringify({ tag, projectId: String(projectId) }),
      "input.mime_type":         "application/json",
      "tag":                     tag,
      "project_id":              String(projectId),
    }, async (rootSpan) => {

      const existing = await getReleaseByTag(projectId, tag);
      if (existing) {
        console.log(`Louisa: GitLab release already exists for ${tag}, skipping`);
        rootSpan.setAttribute("output.value",     "skipped: release already exists");
        rootSpan.setAttribute("output.mime_type", "text/plain");
        return { skipped: true, reason: "release already exists" };
      }

      const previousTag = await activeSpan(tracer, "gitlab.get_previous_tag", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "gitlab.getPreviousReleaseTag",
        "tool.description":        "Finds the most recent release tag before the given tag to determine the commit diff range",
        "tool.parameters":         JSON.stringify({ projectId: "string|number", tag: "string" }),
        "input.value":             JSON.stringify({ projectId, tag }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        const r = await getPreviousReleaseTag(projectId, tag);
        s.setAttribute("output.value",     r || "(none)");
        s.setAttribute("output.mime_type", "text/plain");
        return r;
      });
      console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

      const commits = await activeSpan(tracer, "gitlab.get_commits", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "gitlab.getCommitsBetweenTags",
        "tool.description":        "Retrieves all commits between two tags to identify what changed in this release",
        "tool.parameters":         JSON.stringify({ projectId: "string|number", base: "string", head: "string" }),
        "input.value":             JSON.stringify({ projectId, base: previousTag, head: tag }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        const r = await getCommitsBetweenTags(projectId, previousTag, tag);
        s.setAttribute("output.value",     JSON.stringify(r.map(c => ({ sha: c.sha.slice(0, 7), message: c.message }))));
        s.setAttribute("output.mime_type", "application/json");
        return r;
      });
      console.log(`Louisa: found ${commits.length} commits`);

      const shas = commits.map((c) => c.sha);
      const mergeRequests = await activeSpan(tracer, "gitlab.get_merge_requests", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "gitlab.getMergeRequestsForCommits",
        "tool.description":        "Fetches merged MRs associated with the release commits to enrich release notes with context",
        "tool.parameters":         JSON.stringify({ projectId: "string|number", shas: "string[]" }),
        "input.value":             JSON.stringify({ projectId, commitCount: shas.length }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        const r = await getMergeRequestsForCommits(projectId, shas);
        s.setAttribute("output.value",     JSON.stringify(r.map(mr => ({ number: mr.number, title: mr.title }))));
        s.setAttribute("output.mime_type", "application/json");
        return r;
      });
      console.log(`Louisa: found ${mergeRequests.length} merged MRs`);

      // generatePlatformReleaseNotes() calls client.messages.create() internally.
      // AnthropicInstrumentation auto-creates an LLM span as a child of rootSpan.
      const { text: notes } = await generatePlatformReleaseNotes({ tagName: tag, releaseName: tag, commits, mergeRequests, previousTag });

      const footer  = "\n\n---\n_Release notes generated by Louisa_";
      const created = await activeSpan(tracer, "gitlab.create_release", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "gitlab.createRelease",
        "tool.description":        "Publishes the AI-generated release notes as a GitLab Release for the tag",
        "tool.parameters":         JSON.stringify({ projectId: "string|number", tag: "string", name: "string", description: "string" }),
        "input.value":             JSON.stringify({ projectId, tag }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        const r = await createRelease(projectId, tag, tag, notes + footer);
        s.setAttribute("output.value",     r._links?.self || "");
        s.setAttribute("output.mime_type", "text/plain");
        return r;
      });

      const projectUrl = await activeSpan(tracer, "gitlab.get_project_url", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "gitlab.getProjectUrl",
        "tool.description":        "Retrieves the GitLab project web URL to build the release permalink",
        "tool.parameters":         JSON.stringify({ projectId: "string|number" }),
        "input.value":             String(projectId),
        "input.mime_type":         "text/plain",
      }, async (s) => {
        const r = await getProjectUrl(projectId);
        s.setAttribute("output.value",     r || "");
        s.setAttribute("output.mime_type", "text/plain");
        return r;
      });

      const releaseUrl = projectUrl
        ? `${projectUrl}/-/releases/${encodeURIComponent(tag)}`
        : created._links?.self || "";

      await activeSpan(tracer, "slack.post_notification", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "slack.postReleaseToSlack",
        "tool.description":        "Posts a release summary to the Slack #releases channel via Incoming Webhook",
        "tool.parameters":         JSON.stringify({ tag: "string", releaseUrl: "string", notes: "string" }),
        "input.value":             JSON.stringify({ tag, releaseUrl }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        await postReleaseToSlack(tag, releaseUrl, notes);
        s.setAttribute("output.value",     "notification sent");
        s.setAttribute("output.mime_type", "text/plain");
      });

      rootSpan.setAttribute("output.value",     releaseUrl);
      rootSpan.setAttribute("output.mime_type", "text/plain");
      console.log(`Louisa: GitLab release created for tag ${tag}`);
      return { ok: true, tag, action: "created" };
    });

    await forceFlush();
    return res.status(200).json(result);
  } catch (err) {
    console.error("Louisa: error creating GitLab release", err);
    await forceFlush();
    return res.status(500).json({ error: err.message });
  }
}
