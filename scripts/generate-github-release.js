#!/usr/bin/env node
/**
 * Generate release notes for a GitHub (arthur-engine) production tag.
 * Called by the GitHub Action (.github/workflows/generate-github-release.yml)
 * after a louisa-github-release repository_dispatch event fires from the tag webhook.
 *
 * Flow:
 *   1. Find the previous release tag and compute the date window
 *   2. Fetch commits between tags
 *   3. Fetch PRs merged in the window; summarize any not already in logs/pr-summaries.jsonl
 *      (PRs merged while the Vercel container was ephemeral are caught here)
 *   4. Generate release notes from the compact summaries
 *   5. Create the GitHub release
 *   6. Post notifications
 *
 * The GitHub Action commits the updated logs/ back to the repo so future runs
 * skip already-summarized PRs.
 *
 * Usage:
 *   node scripts/generate-github-release.js \
 *     --owner arthur-ai \
 *     --repo  arthur-engine \
 *     --tag   2.1.516
 *
 * Required env vars:
 *   GITHUB_TOKEN, ANTHROPIC_API_KEY
 * Optional:
 *   SLACK_WEBHOOK_URL, TEAMS_WEBHOOK_URL
 *   ARTHUR_BASE_URL, ARTHUR_API_KEY, ARTHUR_TASK_ID  (tracing)
 */

import {
  getPreviousReleaseTag,
  getTagDate,
  getCommitsBetweenTags,
  getPRsByDateRange,
  getPRCommits,
  getPRFiles,
  getPRComments,
  getReleaseByTag,
  createRelease,
} from "../lib/github.js";
import { summarizePR, generateReleaseNotes } from "../lib/claude.js";
import { appendSummary, readSummariesInRange } from "../lib/summaries.js";
import { postReleaseNotification } from "../lib/slack.js";

// ── Args ──────────────────────────────────────────────────────────────────────

function getArg(name) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

const owner = getArg("--owner") || process.env.GITHUB_REPO_OWNER;
const repo  = getArg("--repo")  || process.env.GITHUB_REPO_NAME;
const tag   = getArg("--tag");

if (!owner || !repo || !tag) {
  console.error("Usage: generate-github-release.js --owner OWNER --repo REPO --tag TAG");
  process.exit(1);
}

const repoSlug = `${owner}/${repo}`;
console.log(`Louisa: generating GitHub release notes for ${repoSlug}@${tag}`);

// ── 1. Idempotency check ─────────────────────────────────────────────────────

const existing = await getReleaseByTag(owner, repo, tag);
if (existing) {
  console.log(`Louisa: release already exists for ${tag} — nothing to do`);
  process.exit(0);
}

// ── 2. Previous tag + date window ────────────────────────────────────────────

const previousTag = await getPreviousReleaseTag(owner, repo, tag);
console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

const [fromTagDate, toTagDate] = await Promise.all([
  previousTag ? getTagDate(owner, repo, previousTag) : Promise.resolve(null),
  getTagDate(owner, repo, tag),
]);

const from = fromTagDate || new Date(0).toISOString();
// Add 10 min buffer so PRs merged during the CI run aren't missed
const to   = toTagDate
  ? new Date(new Date(toTagDate).getTime() + 10 * 60 * 1000).toISOString()
  : new Date().toISOString();

console.log(`Louisa: date window ${from} → ${to}`);

// ── 3. Commits ───────────────────────────────────────────────────────────────

const commits = await getCommitsBetweenTags(owner, repo, previousTag, tag);
console.log(`Louisa: ${commits.length} commits in window`);

// ── 4. Summarize PRs not already in the log ───────────────────────────────────

// PRs logged at merge time by the webhook PR handler (may be partial)
const existingSummaries  = readSummariesInRange(repoSlug, from, to) || [];
const summarizedNumbers  = new Set(existingSummaries.map((e) => e.number));
console.log(`Louisa: ${existingSummaries.length} PRs already in summaries log`);

// All PRs in the window from the GitHub Search API
const apiPRs       = await getPRsByDateRange(owner, repo, from, to);
const unsummarized = apiPRs.filter((pr) => !summarizedNumbers.has(pr.number));
console.log(`Louisa: ${apiPRs.length} PRs in window; ${unsummarized.length} need summarization`);

for (const pr of unsummarized) {
  console.log(`  Summarizing PR #${pr.number}: "${pr.title}"`);
  try {
    const [prCommits, files, comments] = await Promise.all([
      getPRCommits(owner, repo, pr.number),
      getPRFiles(owner, repo, pr.number),
      getPRComments(owner, repo, pr.number),
    ]);

    const { summary, type, userImpact } = await summarizePR({
      platform: "github",
      title:    pr.title,
      body:     pr.body || "",
      commits:  prCommits,
      files,
      comments,
    });

    appendSummary({
      platform:   "github",
      repo:       repoSlug,
      number:     pr.number,
      title:      pr.title,
      summary,
      type,
      userImpact,
      author:     pr.author,
      labels:     pr.labels || [],
      url:        pr.url,
      mergedAt:   pr.mergedAt || new Date().toISOString(),
      tag,
    });

    console.log(`    → [${type}] ${summary.slice(0, 100)}`);
  } catch (err) {
    console.error(`  Failed to summarize PR #${pr.number}: ${err.message}`);
  }
}

// ── 5. Build final PR list from summaries ─────────────────────────────────────

// Re-read after appending new entries
const allSummaries = readSummariesInRange(repoSlug, from, to) || existingSummaries;
const pullRequests = allSummaries.map((entry) => ({
  number: entry.number,
  title:  entry.title,
  body:   `**Summary:** ${entry.summary}\n\n**User Impact:** ${entry.userImpact}\n\n**Type:** ${entry.type}`,
  author: entry.author,
  labels: entry.labels || [],
  url:    entry.url,
}));
console.log(`Louisa: ${pullRequests.length} PR summaries → release notes`);

// ── 6. Generate release notes ─────────────────────────────────────────────────

const { text: notes } = await generateReleaseNotes({
  tagName:     tag,
  releaseName: tag,
  commits,
  pullRequests,
  previousTag,
});

// ── 7. Create GitHub release ──────────────────────────────────────────────────

const footer  = "\n\n---\n_Release notes generated by Louisa_";
const created = await createRelease(owner, repo, tag, tag, notes + footer);
console.log(`Louisa: GitHub release created — ${created.html_url}`);

// ── 8. Notify ─────────────────────────────────────────────────────────────────

await postReleaseNotification(tag, created.html_url, notes);
console.log(`Louisa: notification sent`);
