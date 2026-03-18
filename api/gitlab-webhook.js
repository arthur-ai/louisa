import {
  getCommitsBetweenTags,
  getMergeRequestsForCommits,
  getPreviousReleaseTag,
  getReleaseByTag,
  createRelease,
  getProjectUrl,
  getMRCommits,
  getMRChanges,
  getMRNotes,
  updateMR,
} from "../lib/gitlab.js";
import { generatePlatformReleaseNotes } from "../lib/claude-platform.js";
import { enrichPRDescription, isAlreadyEnriched, shouldSkipEnrichment } from "../lib/enrich.js";
import { postReleaseNotification } from "../lib/slack.js";
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

  // Initialise the OTel provider (+ Anthropic auto-instrumentation) once per container.
  const tracer = getTracer();

  // ─── MR merged: enrich title and description ────────────────────────────────
  if (eventType === "merge_request") {
    const attrs    = payload.object_attributes;
    const mrIid    = attrs?.iid;
    const projectId = attrs?.target_project_id || payload.project?.id || process.env.GITLAB_PROJECT_ID;

    // Only act on the "merge" action (not open, update, close, etc.)
    if (attrs?.action !== "merge") {
      return res.status(200).json({ skipped: true, reason: `mr action=${attrs?.action}` });
    }

    const originalTitle = attrs?.title || "";
    const originalBody  = attrs?.description || "";

    // Skip bot/automated MRs — only enrich work by real developers
    const mrAuthor = payload.user || {};
    const { skip: skipBot, reason: botReason } = shouldSkipEnrichment({
      title:          originalTitle,
      authorUsername: mrAuthor.username ?? "",
      // GitLab marks bot users with user_type === "project_bot" or "service_account"
      authorType:     mrAuthor.bot ? "Bot" : (mrAuthor.user_type ?? ""),
    });
    if (skipBot) {
      console.log(`Louisa: skipping MR !${mrIid} — ${botReason}`);
      return res.status(200).json({ skipped: true, reason: botReason });
    }

    // Idempotency: skip if Louisa has already enriched this MR
    if (isAlreadyEnriched(originalBody)) {
      console.log(`Louisa: MR !${mrIid} already enriched, skipping`);
      return res.status(200).json({ skipped: true, reason: "already enriched" });
    }

    console.log(`Louisa: enriching merged MR !${mrIid} — "${originalTitle}"`);

    try {
      const result = await activeSpan(tracer, "louisa.gitlab.enrich_mr", {
        "openinference.span.kind": "CHAIN",
        "agent.name":              "Louisa",
        "input.value":             JSON.stringify({ event: "mr_merged", mrIid, projectId: String(projectId) }),
        "input.mime_type":         "application/json",
        "mr_iid":                  String(mrIid),
        "project_id":              String(projectId),
      }, async (rootSpan) => {

        const [commits, files, comments] = await activeSpan(tracer, "gitlab.get_mr_context", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "gitlab.getMRContext",
          "tool.description":        "Fetches commits, changed files, and discussion notes from the merged MR",
          "tool.parameters":         JSON.stringify({ projectId: "string|number", mrIid: "integer" }),
          "input.value":             JSON.stringify({ projectId, mrIid }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const [c, f, co] = await Promise.all([
            getMRCommits(projectId, mrIid),
            getMRChanges(projectId, mrIid),
            getMRNotes(projectId, mrIid),
          ]);
          s.setAttribute("output.value",     JSON.stringify({ commits: c.length, files: f.length, comments: co.length }));
          s.setAttribute("output.mime_type", "application/json");
          return [c, f, co];
        });

        console.log(`Louisa: MR !${mrIid} context — ${commits.length} commits, ${files.length} files, ${comments.length} comments`);

        const { title: enrichedTitle, body: enrichedBody } = await activeSpan(tracer, "louisa.enrich_mr_description", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "louisa.enrichMRDescription",
          "tool.description":        "Calls Claude to rewrite the MR title and description into a structured format optimised for release notes and marketing content",
          "tool.parameters":         JSON.stringify({ platform: "string", originalTitle: "string", originalBody: "string", commits: "array", files: "array", comments: "array" }),
          "input.value":             JSON.stringify({ mrIid, originalTitle }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const r = await enrichPRDescription({
            platform:      "gitlab",
            originalTitle,
            originalBody,
            commits,
            files,
            comments,
          });
          s.setAttribute("output.value",     r.title);
          s.setAttribute("output.mime_type", "text/plain");
          return r;
        });

        await activeSpan(tracer, "gitlab.update_mr", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "gitlab.updateMR",
          "tool.description":        "Writes the enriched title and structured description back to the merged MR",
          "tool.parameters":         JSON.stringify({ projectId: "string|number", mrIid: "integer", title: "string", description: "string" }),
          "input.value":             JSON.stringify({ projectId, mrIid, enrichedTitle }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          await updateMR(projectId, mrIid, enrichedTitle, enrichedBody);
          s.setAttribute("output.value",     "updated");
          s.setAttribute("output.mime_type", "text/plain");
        });

        rootSpan.setAttribute("output.value",     `MR !${mrIid} enriched`);
        rootSpan.setAttribute("output.mime_type", "text/plain");
        console.log(`Louisa: MR !${mrIid} enriched — "${enrichedTitle}"`);
        return { ok: true, mrIid, action: "enriched", enrichedTitle };
      });

      await forceFlush();
      return res.status(200).json(result);
    } catch (err) {
      console.error(`Louisa: error enriching MR !${mrIid}`, err);
      await forceFlush();
      return res.status(500).json({ error: err.message });
    }
  }

  // Only handle tag push events for release note generation
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

      // Fetch commits from both platform repos (backend + frontend) in parallel if a second
      // project ID is configured. Falls back to single-repo mode when not set.
      const rawScopeId    = process.env.GITLAB_SCOPE_PROJECT_ID;
      const scopeProjectId = rawScopeId && rawScopeId !== String(projectId) ? rawScopeId : null;
      const [backendCommits, frontendCommits] = await activeSpan(tracer, "gitlab.get_commits", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "gitlab.getCommitsBetweenTags",
        "tool.description":        "Retrieves all commits between two tags across both platform repos (backend + frontend)",
        "tool.parameters":         JSON.stringify({ projectId: "string|number", scopeProjectId: "string|number", base: "string", head: "string" }),
        "input.value":             JSON.stringify({ projectId, scopeProjectId, base: previousTag, head: tag }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        const [bc, fc] = await Promise.all([
          getCommitsBetweenTags(projectId, previousTag, tag),
          scopeProjectId ? getCommitsBetweenTags(scopeProjectId, previousTag, tag) : Promise.resolve([]),
        ]);
        s.setAttribute("output.value",     JSON.stringify({ backend: bc.length, frontend: fc.length }));
        s.setAttribute("output.mime_type", "application/json");
        return [bc, fc];
      });
      const commits = [...backendCommits, ...frontendCommits];
      console.log(`Louisa: found ${commits.length} commits (${backendCommits.length} backend, ${frontendCommits.length} frontend)`);

      const [backendMRs, frontendMRs] = await activeSpan(tracer, "gitlab.get_merge_requests", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "gitlab.getMergeRequestsForCommits",
        "tool.description":        "Fetches merged MRs from both platform repos associated with the release commits",
        "tool.parameters":         JSON.stringify({ projectId: "string|number", scopeProjectId: "string|number", shas: "string[]" }),
        "input.value":             JSON.stringify({ projectId, scopeProjectId, backendCommits: backendCommits.length, frontendCommits: frontendCommits.length }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        const [bmr, fmr] = await Promise.all([
          getMergeRequestsForCommits(projectId, backendCommits.map((c) => c.sha)),
          scopeProjectId ? getMergeRequestsForCommits(scopeProjectId, frontendCommits.map((c) => c.sha)) : Promise.resolve([]),
        ]);
        s.setAttribute("output.value",     JSON.stringify([...bmr, ...fmr].map(mr => ({ number: mr.number, title: mr.title }))));
        s.setAttribute("output.mime_type", "application/json");
        return [bmr, fmr];
      });
      const mergeRequests = [...backendMRs, ...frontendMRs];
      console.log(`Louisa: found ${mergeRequests.length} merged MRs (${backendMRs.length} backend, ${frontendMRs.length} frontend)`);

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
        "tool.name":               "notifications.postReleaseNotification",
        "tool.description":        "Posts a release notification to configured channels (Slack and/or Teams) via Incoming Webhook",
        "tool.parameters":         JSON.stringify({ tag: "string", releaseUrl: "string", notes: "string" }),
        "input.value":             JSON.stringify({ tag, releaseUrl }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        await postReleaseNotification(tag, releaseUrl, notes);
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
