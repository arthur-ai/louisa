#!/usr/bin/env node
/**
 * Generate release notes for a GitLab production tag.
 * Called by the GitHub Action (.github/workflows/generate-release.yml) after
 * a louisa-release repository_dispatch event fires from the GitLab webhook.
 *
 * Flow (within a single run):
 *   1. Find the previous production tag and compute the date window
 *   2. Fetch commits (backend + optional frontend/scope project)
 *   3. Fetch MRs for the window; summarize any not already in logs/pr-summaries.jsonl
 *   4. Generate release notes from the summaries
 *   5. Create the GitLab release
 *   6. Post Slack/Teams notification
 *
 * The GitHub Action then commits the updated logs/ files back to the repo,
 * building a persistent historical record that replaces the ephemeral Vercel filesystem.
 *
 * Usage:
 *   node scripts/generate-release-notes.js \
 *     --tag 1.4.1892-success-aws-prod-platform \
 *     --project-id 48008591 \
 *     [--scope-project-id 12345]
 *
 * Required env vars:
 *   GITLAB_TOKEN, ANTHROPIC_API_KEY
 * Optional:
 *   SLACK_WEBHOOK_URL, TEAMS_WEBHOOK_URL
 *   ARTHUR_BASE_URL, ARTHUR_API_KEY, ARTHUR_TASK_ID  (tracing)
 */

import {
  getPreviousReleaseTag,
  getTagDate,
  getCommitsBetweenTags,
  getCommitsBetweenDates,
  getMRsByDateRange,
  getMRCommits,
  getMRChanges,
  getMRNotes,
  getReleaseByTag,
  createRelease,
  getProjectUrl,
} from "../lib/gitlab.js";
import { summarizePR } from "../lib/claude.js";
import { generatePlatformReleaseNotes } from "../lib/claude-platform.js";
import { appendSummary, readSummariesInRange } from "../lib/summaries.js";
import { postReleaseNotification } from "../lib/slack.js";
import { getTracer, forceFlush, activeSpan } from "../lib/otel.js";
import { trace, context } from "@opentelemetry/api";

// ── Args ──────────────────────────────────────────────────────────────────────

function getArg(name) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

const tag            = getArg("--tag");
const projectId      = getArg("--project-id")       || process.env.GITLAB_PROJECT_ID;
const rawScopeId     = getArg("--scope-project-id") || process.env.GITLAB_SCOPE_PROJECT_ID;
const remoteTraceId  = getArg("--trace-id")         || process.env.REMOTE_TRACE_ID;
const remoteSpanId   = getArg("--span-id")          || process.env.REMOTE_SPAN_ID;
const scopeProjectId = rawScopeId && rawScopeId !== String(projectId) ? rawScopeId : null;

if (!tag || !projectId) {
  console.error("Usage: generate-release-notes.js --tag TAG --project-id ID [--scope-project-id ID]");
  process.exit(1);
}

console.log(`Louisa: generating release notes for ${tag} (project ${projectId}${scopeProjectId ? ` + scope ${scopeProjectId}` : ""})`);

const tracer = getTracer();

// Reconstruct the parent span context from the webhook trace so this Action's
// spans are linked to the originating louisa.gitlab.release CHAIN span.
function buildParentContext() {
  if (!remoteTraceId || !remoteSpanId) return context.active();
  const spanContext = {
    traceId:    remoteTraceId,
    spanId:     remoteSpanId,
    traceFlags: 1, // SAMPLED
    isRemote:   true,
  };
  return trace.setSpanContext(context.active(), spanContext);
}

await context.with(buildParentContext(), async () => {
  await activeSpan(tracer, "louisa.gitlab.release.action", {
    "openinference.span.kind": "CHAIN",
    "agent.name":              "Louisa",
    "input.value":             JSON.stringify({ event: "generate_release_action", tag, projectId: String(projectId), scopeProjectId }),
    "input.mime_type":         "application/json",
    "tag":                     tag,
    "project_id":              String(projectId),
  }, async (rootSpan) => {

    // ── 1. Idempotency check ───────────────────────────────────────────────

    const existing = await getReleaseByTag(projectId, tag);
    if (existing) {
      console.log(`Louisa: release already exists for ${tag} — nothing to do`);
      rootSpan.setAttribute("output.value",     "skipped: release already exists");
      rootSpan.setAttribute("output.mime_type", "text/plain");
      return;
    }

    // ── 2. Previous tag + date window ──────────────────────────────────────

    const previousTag = await activeSpan(tracer, "gitlab.get_previous_tag", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "gitlab.getPreviousReleaseTag",
      "tool.description":        "Finds the most recent production tag before the given tag to determine the commit diff range",
      "tool.parameters":         JSON.stringify({ projectId: "string", tag: "string" }),
      "input.value":             JSON.stringify({ projectId: String(projectId), tag }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      const r = await getPreviousReleaseTag(projectId, tag);
      s.setAttribute("output.value",     r || "(none)");
      s.setAttribute("output.mime_type", "text/plain");
      return r;
    });
    console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

    const [fromTagDate, toTagDate] = await Promise.all([
      previousTag ? getTagDate(projectId, previousTag) : Promise.resolve(null),
      getTagDate(projectId, tag),
    ]);

    const from = fromTagDate || new Date(0).toISOString();
    const to   = toTagDate
      ? new Date(new Date(toTagDate).getTime() + 10 * 60 * 1000).toISOString()
      : new Date().toISOString();

    // ── 3. Commits ─────────────────────────────────────────────────────────

    const [backendCommits, frontendCommits] = await activeSpan(tracer, "gitlab.get_commits", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "gitlab.getCommits",
      "tool.description":        "Fetches commits for the release window from the backend project (by tag range) and optional scope/frontend project (by date range)",
      "tool.parameters":         JSON.stringify({ projectId: "string", previousTag: "string|null", tag: "string", scopeProjectId: "string|null", from: "string", to: "string" }),
      "input.value":             JSON.stringify({ projectId: String(projectId), previousTag, tag, scopeProjectId, from, to }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      const [bc, fc] = await Promise.all([
        getCommitsBetweenTags(projectId, previousTag, tag),
        scopeProjectId ? getCommitsBetweenDates(scopeProjectId, from, to) : Promise.resolve([]),
      ]);
      s.setAttribute("output.value",     JSON.stringify({ backendCommits: bc.length, frontendCommits: fc.length }));
      s.setAttribute("output.mime_type", "application/json");
      return [bc, fc];
    });
    const commits = [...backendCommits, ...frontendCommits];
    console.log(`Louisa: ${commits.length} commits (${backendCommits.length} backend, ${frontendCommits.length} frontend)`);

    // ── 4. Summarize MRs ───────────────────────────────────────────────────

    async function summarizeProject(projId) {
      const mrs = await activeSpan(tracer, "gitlab.get_mrs", {
        "openinference.span.kind": "TOOL",
        "tool.name":               "gitlab.getMRsByDateRange",
        "tool.description":        "Fetches merged MRs within the release date window for a project",
        "tool.parameters":         JSON.stringify({ projId: "string", from: "string", to: "string" }),
        "input.value":             JSON.stringify({ projId: String(projId), from, to }),
        "input.mime_type":         "application/json",
      }, async (s) => {
        const r = await getMRsByDateRange(projId, from, to);
        s.setAttribute("output.value",     JSON.stringify(r.map((m) => ({ number: m.number, title: m.title }))));
        s.setAttribute("output.mime_type", "application/json");
        return r;
      });
      console.log(`Louisa: project ${projId} — ${mrs.length} MRs in window`);

      const alreadyDone = readSummariesInRange(String(projId), from, to) || [];
      const doneKeys    = new Set(alreadyDone.map((e) => `${e.repo}:${e.number}`));

      for (const mr of mrs) {
        const key = `${projId}:${mr.number}`;
        if (doneKeys.has(key)) {
          console.log(`  MR !${mr.number} already summarized — skipping`);
          continue;
        }

        console.log(`  Summarizing MR !${mr.number}: "${mr.title}"`);
        try {
          await activeSpan(tracer, "louisa.summarize_mr", {
            "openinference.span.kind": "TOOL",
            "tool.name":               "louisa.summarizeMR",
            "tool.description":        "Fetches MR context (commits, files, notes) then calls Claude to produce a compact summary for the release log",
            "tool.parameters":         JSON.stringify({ projId: "string", mrNumber: "integer", title: "string" }),
            "input.value":             JSON.stringify({ projId: String(projId), mrNumber: mr.number, title: mr.title }),
            "input.mime_type":         "application/json",
            "mr_iid":                  String(mr.number),
            "project_id":              String(projId),
          }, async (s) => {
            const [mrCommits, files, comments] = await Promise.all([
              getMRCommits(projId, mr.number),
              getMRChanges(projId, mr.number),
              getMRNotes(projId, mr.number),
            ]);

            const { summary, type, userImpact } = await summarizePR({
              platform: "gitlab",
              title:    mr.title,
              body:     mr.body || "",
              commits:  mrCommits,
              files,
              comments,
            });

            appendSummary({
              platform:   "gitlab",
              repo:       String(projId),
              number:     mr.number,
              title:      mr.title,
              summary,
              type,
              userImpact,
              author:     mr.author,
              labels:     mr.labels || [],
              url:        mr.url,
              mergedAt:   mr.mergedAt || new Date().toISOString(),
            });

            s.setAttribute("output.value",     `[${type}] ${summary.slice(0, 200)}`);
            s.setAttribute("output.mime_type", "text/plain");
            console.log(`    → [${type}] ${summary.slice(0, 100)}`);
          });
        } catch (err) {
          console.error(`  Failed to summarize MR !${mr.number}: ${err.message}`);
        }
      }
    }

    await summarizeProject(projectId);
    if (scopeProjectId) await summarizeProject(scopeProjectId);

    // ── 5. Build MR list from summaries ────────────────────────────────────

    function summaryToMR(entry) {
      return {
        number: entry.number,
        title:  entry.title,
        body:   `**Summary:** ${entry.summary}\n\n**User Impact:** ${entry.userImpact}\n\n**Type:** ${entry.type}`,
        author: entry.author,
        labels: entry.labels || [],
        url:    entry.url,
      };
    }

    const backendMRs    = (readSummariesInRange(String(projectId), from, to) || []).map(summaryToMR);
    const frontendMRs   = scopeProjectId
      ? (readSummariesInRange(String(scopeProjectId), from, to) || []).map(summaryToMR)
      : [];
    const mergeRequests = [...backendMRs, ...frontendMRs];
    console.log(`Louisa: ${mergeRequests.length} MR summaries → release notes (${backendMRs.length} backend, ${frontendMRs.length} frontend)`);
    rootSpan.setAttribute("mr_count",     mergeRequests.length);
    rootSpan.setAttribute("commit_count", commits.length);

    // ── 6. Generate release notes ───────────────────────────────────────────

    const { text: notes, usage } = await activeSpan(tracer, "louisa.generate_platform_release_notes", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "louisa.generatePlatformReleaseNotes",
      "tool.description":        "Calls Claude to write polished release notes from commits and merge request summaries",
      "tool.parameters":         JSON.stringify({ tagName: "string", commits: "array", mergeRequests: "array", previousTag: "string|null" }),
      "input.value":             JSON.stringify({ tagName: tag, commitCount: commits.length, mrCount: mergeRequests.length, previousTag }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      const result = await generatePlatformReleaseNotes({
        tagName:       tag,
        releaseName:   tag,
        commits,
        mergeRequests,
        previousTag,
      });
      s.setAttribute("output.value",               result.text.slice(0, 1000));
      s.setAttribute("output.mime_type",           "text/markdown");
      s.setAttribute("llm.token_count.prompt",     result.usage.inputTokens);
      s.setAttribute("llm.token_count.completion", result.usage.outputTokens);
      s.setAttribute("llm.token_count.total",      result.usage.totalTokens);
      s.setAttribute("llm.token_count.cache_read",  result.usage.cacheReadTokens);
      s.setAttribute("llm.token_count.cache_write", result.usage.cacheWriteTokens);
      return result;
    });

    // ── 7. Create GitLab release ────────────────────────────────────────────

    await activeSpan(tracer, "gitlab.create_release", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "gitlab.createRelease",
      "tool.description":        "Publishes the AI-generated release notes as a GitLab Release for the tag",
      "tool.parameters":         JSON.stringify({ projectId: "string", tag: "string", name: "string", body: "string" }),
      "input.value":             JSON.stringify({ projectId: String(projectId), tag }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      const footer = "\n\n---\n_Release notes generated by Louisa_";
      await createRelease(projectId, tag, tag, notes + footer);
      s.setAttribute("output.value",     tag);
      s.setAttribute("output.mime_type", "text/plain");
      console.log(`Louisa: GitLab release created — ${tag}`);
    });

    // ── 8. Notify ───────────────────────────────────────────────────────────

    await activeSpan(tracer, "slack.post_notification", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "notifications.postReleaseNotification",
      "tool.description":        "Posts a release notification to configured channels (Slack and/or Teams) via Incoming Webhook",
      "tool.parameters":         JSON.stringify({ tag: "string", releaseUrl: "string", notes: "string" }),
      "input.value":             JSON.stringify({ tag }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      const projectUrl = await getProjectUrl(projectId);
      const releaseUrl = projectUrl
        ? `${projectUrl}/-/releases/${encodeURIComponent(tag)}`
        : "";
      await postReleaseNotification(tag, releaseUrl, notes);
      s.setAttribute("output.value",     "notification sent");
      s.setAttribute("output.mime_type", "text/plain");
      console.log(`Louisa: notification sent`);
    });

    rootSpan.setAttribute("output.value",     tag);
    rootSpan.setAttribute("output.mime_type", "text/plain");
  });
});

await forceFlush();
