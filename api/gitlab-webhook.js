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
import { createTrace, traced } from "../lib/tracing.js";

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

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
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

  const tag = ref.replace("refs/tags/", "");
  const projectId = payload.project_id || process.env.GITLAB_PROJECT_ID;

  console.log(`Louisa: GitLab tag detected — ${tag} (project ${projectId})`);

  const trace = createTrace();
  const root = trace.span("louisa.gitlab.release", null, [
    ["openinference.span.kind", "CHAIN"],
    ["input.value", JSON.stringify({ tag, projectId: String(projectId) })],
    ["input.mime_type", "application/json"],
    ["tag", tag],
    ["project_id", String(projectId)],
  ]);

  try {
    const existing = await getReleaseByTag(projectId, tag);
    if (existing) {
      console.log(`Louisa: GitLab release already exists for ${tag}, skipping`);
      root.addAttr("output.value", "skipped: release already exists");
      root.addAttr("output.mime_type", "text/plain");
      root.end();
      await trace.send().catch(() => {});
      return res.status(200).json({ skipped: true, reason: "release already exists" });
    }

    const previousTag = await traced(
      trace,
      "gitlab.get_previous_tag",
      [
        ["openinference.span.kind", "TOOL"],
        ["tool.name", "gitlab.getPreviousReleaseTag"],
        ["input.value", JSON.stringify({ projectId, tag })],
        ["input.mime_type", "application/json"],
      ],
      root.spanId,
      async (s) => {
        const result = await getPreviousReleaseTag(projectId, tag);
        s.addAttr("output.value", result || "(none)");
        s.addAttr("output.mime_type", "text/plain");
        return result;
      }
    );
    console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

    const commits = await traced(
      trace,
      "gitlab.get_commits",
      [
        ["openinference.span.kind", "TOOL"],
        ["tool.name", "gitlab.getCommitsBetweenTags"],
        ["input.value", JSON.stringify({ projectId, base: previousTag, head: tag })],
        ["input.mime_type", "application/json"],
      ],
      root.spanId,
      async (s) => {
        const result = await getCommitsBetweenTags(projectId, previousTag, tag);
        s.addAttr("output.value", JSON.stringify(result.map(c => ({ sha: c.sha.slice(0, 7), message: c.message }))));
        s.addAttr("output.mime_type", "application/json");
        return result;
      }
    );
    console.log(`Louisa: found ${commits.length} commits`);

    const shas = commits.map((c) => c.sha);
    const mergeRequests = await traced(
      trace,
      "gitlab.get_merge_requests",
      [
        ["openinference.span.kind", "TOOL"],
        ["tool.name", "gitlab.getMergeRequestsForCommits"],
        ["input.value", JSON.stringify({ projectId, commitCount: shas.length })],
        ["input.mime_type", "application/json"],
      ],
      root.spanId,
      async (s) => {
        const result = await getMergeRequestsForCommits(projectId, shas);
        s.addAttr("output.value", JSON.stringify(result.map(mr => ({ number: mr.number, title: mr.title }))));
        s.addAttr("output.mime_type", "application/json");
        return result;
      }
    );
    console.log(`Louisa: found ${mergeRequests.length} merged MRs`);

    const { text: notes, usage, systemPrompt, userContent } = await traced(
      trace,
      "claude.generate_release_notes",
      [
        ["openinference.span.kind", "LLM"],
        ["llm.model_name", "claude-sonnet-4-20250514"],
        ["llm.invocation_parameters", JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4096 })],
      ],
      root.spanId,
      async (s) => {
        const result = await generatePlatformReleaseNotes({ tagName: tag, releaseName: tag, commits, mergeRequests, previousTag });
        s.addAttr("llm.system", result.systemPrompt);
        s.addAttr("llm.input_messages.0.message.role", "user");
        s.addAttr("llm.input_messages.0.message.content", result.userContent);
        s.addAttr("llm.output_messages.0.message.role", "assistant");
        s.addAttr("llm.output_messages.0.message.content", result.text);
        s.addAttr("llm.token_count.prompt", result.usage.inputTokens);
        s.addAttr("llm.token_count.completion", result.usage.outputTokens);
        s.addAttr("llm.token_count.total", result.usage.totalTokens);
        s.addAttr("input.value", result.userContent);
        s.addAttr("input.mime_type", "text/plain");
        s.addAttr("output.value", result.text);
        s.addAttr("output.mime_type", "text/plain");
        return result;
      }
    );

    const footer = "\n\n---\n_Release notes generated by Louisa_";
    const created = await traced(
      trace,
      "gitlab.create_release",
      [
        ["openinference.span.kind", "TOOL"],
        ["tool.name", "gitlab.createRelease"],
        ["input.value", JSON.stringify({ projectId, tag })],
        ["input.mime_type", "application/json"],
      ],
      root.spanId,
      async (s) => {
        const result = await createRelease(projectId, tag, tag, notes + footer);
        s.addAttr("output.value", result._links?.self || "");
        s.addAttr("output.mime_type", "text/plain");
        return result;
      }
    );

    const projectUrl = await traced(
      trace,
      "gitlab.get_project_url",
      [
        ["openinference.span.kind", "TOOL"],
        ["tool.name", "gitlab.getProjectUrl"],
        ["input.value", String(projectId)],
        ["input.mime_type", "text/plain"],
      ],
      root.spanId,
      async (s) => {
        const result = await getProjectUrl(projectId);
        s.addAttr("output.value", result || "");
        s.addAttr("output.mime_type", "text/plain");
        return result;
      }
    );

    const releaseUrl = projectUrl
      ? `${projectUrl}/-/releases/${encodeURIComponent(tag)}`
      : created._links?.self || "";

    await traced(
      trace,
      "slack.post_notification",
      [
        ["openinference.span.kind", "TOOL"],
        ["tool.name", "slack.postReleaseToSlack"],
        ["input.value", JSON.stringify({ tag, releaseUrl })],
        ["input.mime_type", "application/json"],
      ],
      root.spanId,
      async (s) => {
        await postReleaseToSlack(tag, releaseUrl, notes);
        s.addAttr("output.value", "sent");
        s.addAttr("output.mime_type", "text/plain");
      }
    );

    root.addAttr("output.value", releaseUrl);
    root.addAttr("output.mime_type", "text/plain");
    root.end();
    console.log(`Louisa: GitLab release created for tag ${tag}`);
    await trace.send().catch(() => {});
    return res.status(200).json({ ok: true, tag, action: "created" });
  } catch (err) {
    root.end(err);
    console.error("Louisa: error creating GitLab release", err);
    await trace.send().catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
