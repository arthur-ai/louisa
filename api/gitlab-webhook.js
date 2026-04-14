import {
  getReleaseByTag,
  getMRCommits,
  getMRChanges,
  getMRNotes,
} from "../lib/gitlab.js";
import { summarizePR } from "../lib/claude.js";
import { appendSummary } from "../lib/summaries.js";
import { shouldSkipEnrichment } from "../lib/enrich.js";
import { getTracer, forceFlush, activeSpan } from "../lib/otel.js";
import { getInstallationToken } from "../lib/github-app.js";

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
    // Quick idempotency check — if the release already exists, no need to trigger the Action.
    const existing = await getReleaseByTag(projectId, tag);
    if (existing) {
      console.log(`Louisa: GitLab release already exists for ${tag}, skipping`);
      return res.status(200).json({ skipped: true, reason: "release already exists" });
    }

    // Dispatch the GitHub Action which will: summarize MRs → generate notes → create release → notify.
    const rawScopeId     = process.env.GITLAB_SCOPE_PROJECT_ID;
    const scopeProjectId = rawScopeId && rawScopeId !== String(projectId) ? rawScopeId : null;
    await dispatchReleaseAction({ tag, projectId: String(projectId), scopeProjectId });

    console.log(`Louisa: dispatched release Action for ${tag}`);
    await forceFlush();
    return res.status(200).json({ ok: true, tag, action: "dispatched" });
  } catch (err) {
    console.error("Louisa: error dispatching release Action", err);
    await forceFlush();
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Fire a repository_dispatch to the Louisa GitHub repo so the
 * generate-release.yml Action takes over: summarize MRs, generate notes,
 * create the GitLab release, and post notifications.
 *
 * Requires env vars:
 *   LOUISA_GITHUB_REPO  — "owner/repo" of this repo, e.g. "arthur-ai/louisa"
 *   GITHUB_TOKEN        — PAT with repo dispatch permission
 */
async function dispatchReleaseAction({ tag, projectId, scopeProjectId }) {
  const repo = process.env.LOUISA_GITHUB_REPO;
  if (!repo) {
    throw new Error("LOUISA_GITHUB_REPO must be set to dispatch release Action");
  }
  const token = await getInstallationToken();
  const [owner, repoName] = repo.split("/");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/dispatches`, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type:     "louisa-release",
      client_payload: { tag, projectId, scopeProjectId: scopeProjectId || null },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub dispatch failed: ${res.status} ${err}`);
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
