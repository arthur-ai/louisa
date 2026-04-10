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
import { appendSummary, readSummariesForTag, readSummariesInRange } from "../lib/summaries.js";
import { postReleaseNotification } from "../lib/slack.js";

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

// ── 1. Idempotency check ─────────────────────────────────────────────────────

const existing = await getReleaseByTag(projectId, tag);
if (existing) {
  console.log(`Louisa: release already exists for ${tag} — nothing to do`);
  process.exit(0);
}

// ── 2. Previous tag + date window ────────────────────────────────────────────

const previousTag = await getPreviousReleaseTag(projectId, tag);
console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

const [fromTagDate, toTagDate] = await Promise.all([
  previousTag ? getTagDate(projectId, previousTag) : Promise.resolve(null),
  getTagDate(projectId, tag),
]);

const from = fromTagDate || new Date(0).toISOString();
// Add 10 min buffer to toDate so MRs merged during the CI run aren't missed
const to   = toTagDate
  ? new Date(new Date(toTagDate).getTime() + 10 * 60 * 1000).toISOString()
  : new Date().toISOString();

// ── 3. Commits ───────────────────────────────────────────────────────────────

const frontendCommitPromise = (() => {
  if (!scopeProjectId) return Promise.resolve([]);
  // Scope project uses different tags — query by date range instead
  return getCommitsBetweenDates(scopeProjectId, from, to);
})();

const [backendCommits, frontendCommits] = await Promise.all([
  getCommitsBetweenTags(projectId, previousTag, tag),
  frontendCommitPromise,
]);
const commits = [...backendCommits, ...frontendCommits];
console.log(`Louisa: ${commits.length} commits (${backendCommits.length} backend, ${frontendCommits.length} frontend)`);

// ── 4. Summarize MRs ─────────────────────────────────────────────────────────

async function summarizeProject(projId) {
  const mrs = await getMRsByDateRange(projId, from, to);
  console.log(`Louisa: project ${projId} — ${mrs.length} MRs in window`);

  // Use tag-based lookup for idempotency — more reliable than date range
  const alreadyDone = readSummariesForTag(String(projId), tag) || [];
  const doneKeys    = new Set(alreadyDone.map((e) => `${e.repo}:${e.number}`));

  for (const mr of mrs) {
    const key = `${projId}:${mr.number}`;
    if (doneKeys.has(key)) {
      console.log(`  MR !${mr.number} already summarized — skipping`);
      continue;
    }

    console.log(`  Summarizing MR !${mr.number}: "${mr.title}"`);
    try {
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
        tag,
      });

      console.log(`    → [${type}] ${summary.slice(0, 100)}`);
    } catch (err) {
      console.error(`  Failed to summarize MR !${mr.number}: ${err.message}`);
    }
  }
}

await summarizeProject(projectId);
if (scopeProjectId) await summarizeProject(scopeProjectId);

// ── 5. Build MR list from summaries ─────────────────────────────────────────

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

const backendMRs  = (readSummariesForTag(String(projectId), tag) || []).map(summaryToMR);
const frontendMRs = scopeProjectId
  ? (readSummariesForTag(String(scopeProjectId), tag) || []).map(summaryToMR)
  : [];
const mergeRequests = [...backendMRs, ...frontendMRs];
console.log(`Louisa: ${mergeRequests.length} MR summaries → release notes (${backendMRs.length} backend, ${frontendMRs.length} frontend)`);

// ── 6. Generate release notes ────────────────────────────────────────────────

const { text: notes } = await generatePlatformReleaseNotes({
  tagName:       tag,
  releaseName:   tag,
  commits,
  mergeRequests,
  previousTag,
});

// ── 7. Create GitLab release ─────────────────────────────────────────────────

const footer = "\n\n---\n_Release notes generated by Louisa_";
await createRelease(projectId, tag, tag, notes + footer);
console.log(`Louisa: GitLab release created — ${tag}`);

// ── 8. Notify ────────────────────────────────────────────────────────────────

const projectUrl = await getProjectUrl(projectId);
const releaseUrl = projectUrl
  ? `${projectUrl}/-/releases/${encodeURIComponent(tag)}`
  : "";

await postReleaseNotification(tag, releaseUrl, notes);
console.log(`Louisa: notification sent`);
