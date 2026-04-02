import {
  getCommitsBetweenTags,
  getMRsByDateRange,
  getTagDate,
  getPreviousReleaseTag,
  getReleaseByTag,
  createRelease,
  getProjectUrl,
  getMRCommits,
  getMRChanges,
  getMRNotes,
} from "../lib/gitlab.js";
import { summarizePR } from "../lib/claude.js";
import { generatePlatformReleaseNotes } from "../lib/claude-platform.js";
import { appendSummary, readSummariesInRange } from "../lib/summaries.js";
import { shouldSkipEnrichment } from "../lib/enrich.js";
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

  // ─── MR merged: generate summary and append to log ────────────────────────
  if (eventType === "merge_request") {
    return handleMRMerged(req, res, tracer, payload);
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
  // Suffix is configurable via GITLAB_PROD_TAG_SUFFIX env var (defaults to -success-aws-prod-platform).
  const prodTagSuffix = process.env.GITLAB_PROD_TAG_SUFFIX || "-success-aws-prod-platform";
  if (!tag.endsWith(prodTagSuffix)) {
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
      if (scopeProjectId && frontendCommits.length === 0) {
        console.warn(`Louisa: no commits from scope project ${scopeProjectId} for range ${previousTag}...${tag} — verify tag exists in that repo`);
      }

      const [fromTagDate, toTagDate] = await Promise.all([
        previousTag ? getTagDate(projectId, previousTag) : Promise.resolve(null),
        getTagDate(projectId, tag),
      ]);
      const [backendMRs, frontendMRs] = await activeSpan(tracer, "gitlab.get_merge_requests", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "gitlab.getMRsForRelease",
        "tool.description":        "Resolves merged MRs for the release window — reads pre-computed summaries from log if available, falls back to GitLab API",
        "tool.parameters":         JSON.stringify({ projectId: "string|number", scopeProjectId: "string|number", fromDate: "string", toDate: "string" }),
        "input.value":             JSON.stringify({ projectId, scopeProjectId, fromDate: fromTagDate, toDate: toTagDate }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        if (previousTag && !fromTagDate) {
          console.warn(`Louisa: could not resolve date for previous tag ${previousTag} — skipping MR fetch to avoid epoch-range query`);
          s.setAttribute("output.value",     "[]");
          s.setAttribute("output.mime_type", "application/json");
          return [[], []];
        }
        const from = fromTagDate || new Date(0).toISOString();
        const to   = toTagDate
          ? new Date(new Date(toTagDate).getTime() + 10 * 60 * 1000).toISOString()
          : new Date().toISOString();

        // Try the local summaries log first — populated at MR merge time
        const cachedBackend  = readSummariesInRange(String(projectId), from, to);
        const cachedFrontend = scopeProjectId ? readSummariesInRange(String(scopeProjectId), from, to) : [];
        if (cachedBackend !== null) {
          const toMR = (entry) => ({
            number: entry.number,
            title:  entry.title,
            body:   `**Summary:** ${entry.summary}\n\n**User Impact:** ${entry.userImpact}\n\n**Type:** ${entry.type}`,
            author: entry.author,
            labels: entry.labels || [],
            url:    entry.url,
          });
          const bmr = cachedBackend.map(toMR);
          const fmr = (cachedFrontend || []).map(toMR);
          console.log(`Louisa: using pre-computed summaries from log (${bmr.length} backend, ${fmr.length} frontend)`);
          s.setAttribute("output.value",     JSON.stringify([...bmr, ...fmr].map(mr => ({ number: mr.number, title: mr.title }))));
          s.setAttribute("output.mime_type", "application/json");
          return [bmr, fmr];
        }

        // Summaries log absent — fall back to live GitLab API
        console.log(`Louisa: summaries log not found, fetching MRs from GitLab API`);
        const [bmr, fmr] = await Promise.all([
          getMRsByDateRange(projectId, from, to),
          scopeProjectId ? getMRsByDateRange(scopeProjectId, from, to) : Promise.resolve([]),
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

// ─── MR merged: generate summary and append to log ───────────────────────────
async function handleMRMerged(req, res, tracer, payload) {
  const attrs     = payload.object_attributes;
  const mrIid     = attrs?.iid;
  const projectId = String(attrs?.target_project_id || payload.project?.id || process.env.GITLAB_PROJECT_ID);

  if (attrs?.action !== "merge") {
    return res.status(200).json({ skipped: true, reason: `mr action=${attrs?.action}` });
  }

  const originalTitle = attrs?.title || "";
  const mrAuthor      = payload.user || {};
  const { skip, reason: skipReason } = shouldSkipEnrichment({
    title:          originalTitle,
    authorUsername: mrAuthor.username ?? "",
    authorType:     mrAuthor.bot ? "Bot" : (mrAuthor.user_type ?? ""),
  });
  if (skip) {
    console.log(`Louisa: skipping MR !${mrIid} — ${skipReason}`);
    return res.status(200).json({ skipped: true, reason: skipReason });
  }

  console.log(`Louisa: summarising merged MR !${mrIid} — "${originalTitle}"`);

  try {
    const result = await activeSpan(tracer, "louisa.gitlab.summarize_mr", {
      "openinference.span.kind": "CHAIN",
      "agent.name":              "Louisa",
      "input.value":             JSON.stringify({ event: "mr_merged", mrIid, projectId }),
      "input.mime_type":         "application/json",
      "mr_iid":                  String(mrIid),
      "project_id":              projectId,
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

      const { summary, type, userImpact } = await activeSpan(tracer, "louisa.summarize_mr", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "louisa.summarizePR",
        "tool.description":        "Calls Claude to generate a compact summary of the MR for the summaries log",
        "tool.parameters":         JSON.stringify({ platform: "string", title: "string", body: "string", commits: "array", files: "array", comments: "array" }),
        "input.value":             JSON.stringify({ mrIid, title: originalTitle }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        const r = await summarizePR({
          platform: "gitlab",
          title:    originalTitle,
          body:     attrs?.description || "",
          commits,
          files,
          comments,
        });
        s.setAttribute("output.value",     r.summary);
        s.setAttribute("output.mime_type", "text/plain");
        return r;
      });

      appendSummary({
        platform:   "gitlab",
        repo:       projectId,
        number:     mrIid,
        title:      originalTitle,
        summary,
        type,
        userImpact,
        author:     mrAuthor.username,
        labels:     attrs?.labels || [],
        url:        attrs?.url,
        mergedAt:   attrs?.merged_at || new Date().toISOString(),
      });

      rootSpan.setAttribute("output.value",     `MR !${mrIid} summarised`);
      rootSpan.setAttribute("output.mime_type", "text/plain");
      console.log(`Louisa: MR !${mrIid} summarised (${type})`);
      return { ok: true, mrIid, action: "summarised", type };
    });

    await forceFlush();
    return res.status(200).json(result);
  } catch (err) {
    console.error(`Louisa: error summarising MR !${mrIid}`, err);
    await forceFlush();
    return res.status(500).json({ error: err.message });
  }
}
