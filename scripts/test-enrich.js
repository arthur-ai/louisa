#!/usr/bin/env node
/**
 * Smoke-test the PR enrichment pipeline against a real merged PR.
 *
 * Usage:
 *   # Enrich the most recently merged PR (dry-run — prints result, no write)
 *   node scripts/test-enrich.js
 *
 *   # Enrich a specific PR number (dry-run)
 *   node scripts/test-enrich.js --pr 123
 *
 *   # Dry-run but against a specific repo
 *   node scripts/test-enrich.js --owner arthur-ai --repo arthur-engine
 *
 *   # Actually write the enriched content back to the PR
 *   node scripts/test-enrich.js --pr 123 --write
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
import { enrichPRDescription, isAlreadyEnriched } from "../lib/enrich.js";

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};
const has = (name) => args.includes(name);

const owner    = flag("--owner") ?? process.env.GITHUB_REPO_OWNER ?? "arthur-ai";
const repo     = flag("--repo")  ?? process.env.GITHUB_REPO_NAME  ?? "arthur-engine";
const prArg    = flag("--pr");
const writeBack = has("--write");

// ── Helpers ───────────────────────────────────────────────────────────────────

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchRecentMergedPRs(count = 5) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${count}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${body}`);
  }
  const prs = await res.json();
  return prs.filter((p) => p.merged_at);
}

async function fetchPR(prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${body}`);
  }
  return res.json();
}

function separator(label = "") {
  const line = "─".repeat(70);
  return label ? `\n${line}\n  ${label}\n${line}` : `\n${line}`;
}

function truncate(str, max = 800) {
  if (!str) return "(empty)";
  return str.length > max ? str.slice(0, max) + `\n… [${str.length - max} chars truncated]` : str;
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

console.log(`\nLouisa enrichment test — ${owner}/${repo}\n`);

// Resolve which PR to test
let pr;
if (prArg) {
  console.log(`Fetching PR #${prArg}...`);
  pr = await fetchPR(parseInt(prArg, 10));
  if (!pr.merged_at) {
    console.error(`PR #${prArg} has not been merged. Pick a merged PR.`);
    process.exit(1);
  }
} else {
  console.log("Fetching 5 most recently merged PRs...");
  const recent = await fetchRecentMergedPRs(5);
  if (recent.length === 0) {
    console.error("No recently merged PRs found.");
    process.exit(1);
  }
  pr = recent[0];
  console.log(`Using most recently merged: PR #${pr.number} — "${pr.title}"`);
  console.log(`(Pass --pr <number> to test a specific PR)\n`);
}

// Check idempotency guard
if (isAlreadyEnriched(pr.body)) {
  console.warn(`⚠ PR #${pr.number} has already been enriched by Louisa.`);
  console.warn(`  Pass --write to overwrite, or pick a different PR with --pr.\n`);
  if (!writeBack) process.exit(0);
}

// Show original
console.log(separator("ORIGINAL TITLE"));
console.log(pr.title);
console.log(separator("ORIGINAL DESCRIPTION"));
console.log(truncate(pr.body));

// Fetch context
console.log(separator("FETCHING CONTEXT"));
console.log(`Fetching commits, files, and comments for PR #${pr.number}...`);

const [commits, files, comments] = await Promise.all([
  getPRCommits(owner, repo, pr.number),
  getPRFiles(owner, repo, pr.number),
  getPRComments(owner, repo, pr.number),
]);

console.log(`  Commits  : ${commits.length}`);
console.log(`  Files    : ${files.length}`);
console.log(`  Comments : ${comments.length}`);

if (commits.length > 0) {
  console.log("\nSample commits:");
  commits.slice(0, 5).forEach((c) => console.log(`  ${c.sha}  ${c.message}  (${c.author})`));
  if (commits.length > 5) console.log(`  … and ${commits.length - 5} more`);
}

if (files.length > 0) {
  console.log("\nChanged files:");
  files.slice(0, 8).forEach((f) => console.log(`  ${f.status.padEnd(8)} ${f.filename}  +${f.additions}/-${f.deletions}`));
  if (files.length > 8) console.log(`  … and ${files.length - 8} more`);
}

// Run enrichment
console.log(separator("CALLING CLAUDE"));
console.log("Enriching description...");
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
console.log(`Done in ${elapsed}s  (${usage.inputTokens} in / ${usage.outputTokens} out tokens)\n`);

// Show result
console.log(separator("ENRICHED TITLE"));
console.log(enrichedTitle);
console.log(separator("ENRICHED DESCRIPTION"));
console.log(enrichedBody);
console.log(separator());

// Write back (optional)
if (writeBack) {
  console.log(`\n⚠  Writing enriched content back to PR #${pr.number}...`);
  await updatePR(owner, repo, pr.number, enrichedTitle, enrichedBody);
  console.log(`✓  PR #${pr.number} updated: https://github.com/${owner}/${repo}/pull/${pr.number}`);
} else {
  console.log(`\nDry-run complete. To write back, re-run with: --pr ${pr.number} --write`);
}
