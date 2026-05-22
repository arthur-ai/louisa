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
 *
 * Tracing follows the Arthur OpenInference convention:
 *   - one root CHAIN span for the whole pipeline (session.id = tag)
 *   - sub-CHAIN spans for per-project and per-MR summarization (each groups one or more LLM calls)
 *   - LLM spans come automatically from AnthropicInstrumentation in lib/otel.js
 *   - GitLab API calls are intentionally not wrapped as TOOL spans — TOOL is for LLM-invoked tools
 */

import { getTracer, activeSpan, forceFlush } from "../lib/otel.js";
import {
  getPreviousReleaseTag,
  getCommitsBetweenTags,
  getCommitsBetweenDates,
  getMergeRequestsForCommits,
  getMRCommits,
  getMRChanges,
  getMRNotes,
  getReleaseByTag,
  createRelease,
  getProjectUrl,
} from "../lib/gitlab.js";
import { summarizePR } from "../lib/claude.js";
import { generatePlatformReleaseNotes } from "../lib/claude-platform.js";
import { appendSummary, readSummariesForTag, readSummariesInRange } from "../lib/summaries.js";
import { postReleaseNotification } from "../lib/slack.js";

// Initialise OTel provider + Anthropic auto-instrumentation before any
// lib/claude*.js function lazily constructs an Anthropic client.
const tracer = getTracer();

// ── Args ──────────────────────────────────────────────────────────────────────

function getArg(name) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

const tag          = getArg("--tag");
const projectId    = getArg("--project-id")       || process.env.GITLAB_PROJECT_ID;
const rawScopeId   = getArg("--scope-project-id") || process.env.GITLAB_SCOPE_PROJECT_ID;
const scopeProjectId = rawScopeId && rawScopeId !== String(projectId) ? rawScopeId : null;

if (!tag || !projectId) {
  console.error("Usage: generate-release-notes.js --tag TAG --project-id ID [--scope-project-id ID]");
  process.exit(1);
}

console.log(`Louisa: generating release notes for ${tag} (project ${projectId}${scopeProjectId ? ` + scope ${scopeProjectId}` : ""})`);

// ── Per-project summarization (CHAIN — groups one LLM call per uncached MR) ──

async function summarizeProject(projId, commits) {
  return activeSpan(tracer, "louisa.summarize_project", {
    "openinference.span.kind": "CHAIN",
    "input.value":             JSON.stringify({ projectId: String(projId), commits: commits.length, tag }),
    "input.mime_type":         "application/json",
    "project_id":              String(projId),
    "tag":                     tag,
  }, async (chainSpan) => {
    const commitShas = commits.map((c) => c.sha);
    const mrs = await getMergeRequestsForCommits(projId, commitShas);
    console.log(`Louisa: project ${projId} — ${mrs.length} MRs for ${commitShas.length} commits`);

    const relevantNumbers = new Set(mrs.map((mr) => mr.number));
    const alreadyDone = readSummariesForTag(String(projId), tag) || [];
    const doneKeys    = new Set(alreadyDone.map((e) => `${e.repo}:${e.number}`));

    let summarized = 0;
    let skipped    = 0;
    let failed     = 0;

    for (const mr of mrs) {
      const key = `${projId}:${mr.number}`;
      if (doneKeys.has(key)) {
        console.log(`  MR !${mr.number} already summarized — skipping`);
        skipped++;
        continue;
      }

      console.log(`  Summarizing MR !${mr.number}: "${mr.title}"`);
      try {
        await activeSpan(tracer, "louisa.summarize_mr", {
          "openinference.span.kind": "CHAIN",
          "input.value":             JSON.stringify({ mrIid: mr.number, title: mr.title, projectId: String(projId), tag }),
          "input.mime_type":         "application/json",
          "mr_iid":                  String(mr.number),
          "project_id":              String(projId),
          "tag":                     tag,
        }, async (mrSpan) => {
          const [mrCommits, files, comments] = await Promise.all([
            getMRCommits(projId, mr.number),
            getMRChanges(projId, mr.number),
            getMRNotes(projId, mr.number),
          ]);

          // The Anthropic call inside summarizePR becomes an auto-instrumented LLM child span.
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
            tag,
          });

          mrSpan.setAttribute("output.value",     JSON.stringify({ type, summary }));
          mrSpan.setAttribute("output.mime_type", "application/json");
          console.log(`    → [${type}] ${summary.slice(0, 100)}`);
        });
        summarized++;
      } catch (err) {
        console.error(`  Failed to summarize MR !${mr.number}: ${err.message}`);
        failed++;
      }
    }

    chainSpan.setAttribute("output.value", JSON.stringify({
      mrCount: relevantNumbers.size,
      summarized,
      skipped,
      failed,
    }));
    chainSpan.setAttribute("output.mime_type", "application/json");
    return relevantNumbers;
  });
}

// ── Main pipeline (root CHAIN — session = release tag) ──────────────────────

try {
  await activeSpan(tracer, "louisa.generate_release", {
    "openinference.span.kind": "CHAIN",
    "session.id":              tag,
    "input.value":             JSON.stringify({ tag, projectId: String(projectId), scopeProjectId: scopeProjectId || null }),
    "input.mime_type":         "application/json",
    "tag":                     tag,
    "project_id":              String(projectId),
    "scope_project_id":        scopeProjectId ? String(scopeProjectId) : "",
  }, async (rootSpan) => {
    // 1. Idempotency
    const existing = await getReleaseByTag(projectId, tag);
    if (existing) {
      console.log(`Louisa: release already exists for ${tag} — nothing to do`);
      rootSpan.setAttribute("output.value",     "release already exists — skipped");
      rootSpan.setAttribute("output.mime_type", "text/plain");
      return;
    }

    // 2. Previous tag + date window
    const { name: previousTag, fromDate, toDate } = await getPreviousReleaseTag(projectId, tag);
    console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

    const from = fromDate || new Date(0).toISOString();
    // Add 10 min buffer to toDate so MRs merged during the CI run aren't missed
    const to   = toDate
      ? new Date(new Date(toDate).getTime() + 10 * 60 * 1000).toISOString()
      : new Date().toISOString();

    // 3. Commits (backend + optional frontend/scope)
    const frontendCommitPromise = scopeProjectId
      ? getCommitsBetweenDates(scopeProjectId, from, to)
      : Promise.resolve([]);

    const [backendCommits, frontendCommits] = await Promise.all([
      getCommitsBetweenTags(projectId, previousTag, tag),
      frontendCommitPromise,
    ]);
    const commits = [...backendCommits, ...frontendCommits];
    console.log(`Louisa: ${commits.length} commits (${backendCommits.length} backend, ${frontendCommits.length} frontend)`);

    // 4. Summarize MRs (per-project CHAIN spans contain per-MR CHAIN + auto LLM spans)
    const [backendMrNumbers, frontendMrNumbers] = await Promise.all([
      summarizeProject(projectId, backendCommits),
      scopeProjectId ? summarizeProject(scopeProjectId, frontendCommits) : Promise.resolve(new Set()),
    ]);

    // 5. Build MR list from summaries (filtered to this release's commits)
    function summaryToMR(entry) {
      if (!entry.number) return null;
      return {
        number: entry.number,
        title:  entry.title,
        body:   `**Summary:** ${entry.summary}\n\n**User Impact:** ${entry.userImpact}\n\n**Type:** ${entry.type}`,
        author: entry.author,
        labels: entry.labels || [],
        url:    entry.url,
      };
    }

    const backendMRs  = (readSummariesForTag(String(projectId), tag) || [])
      .filter((e) => e.number && backendMrNumbers.has(e.number))
      .map(summaryToMR)
      .filter(Boolean);
    const frontendMRs = scopeProjectId
      ? (readSummariesForTag(String(scopeProjectId), tag) || [])
          .filter((e) => e.number && frontendMrNumbers.has(e.number))
          .map(summaryToMR)
          .filter(Boolean)
      : [];
    const mergeRequests = [...backendMRs, ...frontendMRs];
    console.log(`Louisa: ${mergeRequests.length} MR summaries → release notes (${backendMRs.length} backend, ${frontendMRs.length} frontend)`);

    // 6. Generate release notes — auto-instrumented LLM child span
    const { text: notes } = await generatePlatformReleaseNotes({
      tagName:       tag,
      releaseName:   tag,
      commits,
      mergeRequests,
      previousTag,
    });

    // 7. Create GitLab release
    const footer = "\n\n---\n_Release notes generated by Louisa_";
    await createRelease(projectId, tag, tag, notes + footer);
    console.log(`Louisa: GitLab release created — ${tag}`);

    // 8. Notify
    const projectUrl = await getProjectUrl(projectId);
    const releaseUrl = projectUrl
      ? `${projectUrl}/-/releases/${encodeURIComponent(tag)}`
      : "";
    await postReleaseNotification(tag, releaseUrl, notes);
    console.log(`Louisa: notification sent`);

    rootSpan.setAttribute("output.value", JSON.stringify({
      tag,
      mrCount:     mergeRequests.length,
      notesLength: notes.length,
    }));
    rootSpan.setAttribute("output.mime_type", "application/json");
  });
} finally {
  await forceFlush();
}
