#!/usr/bin/env node
/**
 * Backfill PR enrichment for all PRs merged since the last release.
 *
 * Usage:
 *   # Dry-run: show what would be enriched (no writes)
 *   node scripts/backfill-enrich.js
 *
 *   # Dry-run against a specific repo
 *   node scripts/backfill-enrich.js --owner arthur-ai --repo arthur-engine
 *
 *   # Actually write enriched content back to GitHub
 *   node scripts/backfill-enrich.js --write
 *
 *   # Limit to N PRs (useful for a first test run)
 *   node scripts/backfill-enrich.js --limit 5 --write
 *
 *   # Override the since-date manually (ISO 8601)
 *   node scripts/backfill-enrich.js --since 2026-02-01T00:00:00Z --write
 *
 * Environment (load with: set -a && source .env.local && set +a)
 *   ANTHROPIC_API_KEY   required
 *   GITHUB_TOKEN        required
 *   GITHUB_REPO_OWNER   default: arthur-ai
 *   GITHUB_REPO_NAME    default: arthur-engine
 */

import {
  getPRCommits,
  getPRFiles,
  getPRComments,
  updatePR,
} from "../lib/github.js";
import { enrichPRDescription, isAlreadyEnriched, shouldSkipEnrichment } from "../lib/enrich.js";

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const flag   = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
const has    = (name) => args.includes(name);

const owner     = flag("--owner") ?? process.env.GITHUB_REPO_OWNER ?? "arthur-ai";
const repo      = flag("--repo")  ?? process.env.GITHUB_REPO_NAME  ?? "arthur-engine";
const writeBack = has("--write");
const limit     = flag("--limit") ? parseInt(flag("--limit"), 10) : Infinity;
const sinceArg  = flag("--since"); // override the auto-detected since date

// ── GitHub helpers ────────────────────────────────────────────────────────────

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function getLastRelease() {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub releases API ${res.status}`);
  const releases = await res.json();
  const published = releases.filter((r) => !r.draft && !r.prerelease);
  return published[0] ?? null;
}

async function getMergedPRsSince(since) {
  // Paginate through closed PRs, collecting those merged after `since`
  const sinceMs = new Date(since).getTime();
  const prs = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) throw new Error(`GitHub pulls API ${res.status}`);
    const batch = await res.json();
    if (batch.length === 0) break;

    let hitCutoff = false;
    for (const pr of batch) {
      if (!pr.merged_at) continue;
      const mergedMs = new Date(pr.merged_at).getTime();
      if (mergedMs < sinceMs) { hitCutoff = true; break; }
      prs.push(pr);
    }

    if (hitCutoff || batch.length < 100) break;
    page++;
  }

  return prs;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmt(date) {
  return new Date(date).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is not set.");
  console.error("Run: set -a && source .env.local && set +a");
  process.exit(1);
}
if (!process.env.GITHUB_TOKEN) {
  console.error("ERROR: GITHUB_TOKEN is not set.");
  process.exit(1);
}

console.log(`\nLouisa enrichment backfill — ${owner}/${repo}`);
console.log(writeBack ? "Mode: WRITE (will update PRs on GitHub)\n" : "Mode: DRY-RUN (pass --write to apply changes)\n");

// Resolve the since date
let since;
if (sinceArg) {
  since = sinceArg;
  console.log(`Using --since override: ${fmt(since)}`);
} else {
  console.log("Fetching last release...");
  const lastRelease = await getLastRelease();
  if (!lastRelease) {
    console.error("No published releases found. Pass --since to set a date manually.");
    process.exit(1);
  }
  since = lastRelease.published_at;
  console.log(`Last release : ${lastRelease.tag_name}  (published ${fmt(since)})`);
}

// Fetch all merged PRs since that date
console.log(`\nFetching PRs merged since ${fmt(since)}...`);
const allPRs = await getMergedPRsSince(since);
console.log(`Found ${allPRs.length} merged PR(s)`);

// Separate PRs into buckets: already enriched, bot/automated, and pending
const enriched  = allPRs.filter((pr) => isAlreadyEnriched(pr.body));
const botPRs    = allPRs.filter((pr) => !isAlreadyEnriched(pr.body) && shouldSkipEnrichment({
  title:          pr.title,
  authorUsername: pr.user?.login ?? "",
  authorType:     pr.user?.type  ?? "",
}).skip);
const pending   = allPRs.filter((pr) => !isAlreadyEnriched(pr.body) && !shouldSkipEnrichment({
  title:          pr.title,
  authorUsername: pr.user?.login ?? "",
  authorType:     pr.user?.type  ?? "",
}).skip);
const toProcess = pending.slice(0, limit);

console.log(`  Already enriched : ${enriched.length}`);
console.log(`  Skipped (bots)   : ${botPRs.length}`);
console.log(`  Pending          : ${pending.length}`);
if (pending.length > toProcess.length) {
  console.log(`  Processing       : ${toProcess.length} (limited by --limit ${limit})`);
}

if (toProcess.length === 0) {
  console.log("\nNothing to do.");
  process.exit(0);
}

// Print the list of PRs to be enriched
console.log("\nPRs to enrich:");
toProcess.forEach((pr, i) => {
  console.log(`  ${String(i + 1).padStart(2)}. #${pr.number}  ${pr.merged_at?.slice(0, 10)}  ${pr.title.slice(0, 70)}`);
});
console.log();

// Process each PR
let succeeded = 0;
let failed    = 0;

for (let i = 0; i < toProcess.length; i++) {
  const pr = toProcess[i];
  const prefix = `[${i + 1}/${toProcess.length}] PR #${pr.number}`;
  process.stdout.write(`${prefix} — fetching context... `);

  try {
    const [commits, files, comments] = await Promise.all([
      getPRCommits(owner, repo, pr.number),
      getPRFiles(owner, repo, pr.number),
      getPRComments(owner, repo, pr.number),
    ]);
    process.stdout.write(`${commits.length}c/${files.length}f/${comments.length}co — enriching... `);

    const start = Date.now();
    const { title: enrichedTitle, body: enrichedBody, usage } = await enrichPRDescription({
      platform:      "github",
      originalTitle: pr.title,
      originalBody:  pr.body || "",
      commits,
      files,
      comments,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`done (${elapsed}s, ${usage.inputTokens}→${usage.outputTokens} tok)\n`);

    console.log(`         Original : ${pr.title}`);
    console.log(`         Enriched : ${enrichedTitle}`);

    if (writeBack) {
      await updatePR(owner, repo, pr.number, enrichedTitle, enrichedBody);
      console.log(`         Written  : https://github.com/${owner}/${repo}/pull/${pr.number}`);
    }

    succeeded++;
  } catch (err) {
    console.error(`\n${prefix} FAILED: ${err.message}`);
    failed++;
  }

  // Rate-limit courtesy pause between PRs (skip after the last one)
  if (i < toProcess.length - 1) await sleep(1500);
}

// Summary
console.log(`\n${"─".repeat(60)}`);
console.log(`Enriched ${succeeded} PR(s)${failed > 0 ? `, ${failed} failed` : ""}.`);
if (!writeBack && succeeded > 0) {
  console.log("Dry-run — re-run with --write to apply changes.");
}
