#!/usr/bin/env node
/**
 * Identify and optionally backfill GitLab prod tags that have no release object.
 *
 * Dry-run (default) — list all tags missing a release:
 *   node scripts/backfill-releases.js
 *   node scripts/backfill-releases.js --days 30
 *
 * Run — generate release notes for each missing tag sequentially:
 *   node scripts/backfill-releases.js --run
 *   node scripts/backfill-releases.js --days 30 --run
 *   node scripts/backfill-releases.js --days 30 --limit 5 --run
 *   node scripts/backfill-releases.js --scope-project-id 54848372 --run
 *
 * Tip: unset SLACK_WEBHOOK_URL before --run to suppress Slack notifications
 * for the backfilled releases:
 *   unset SLACK_WEBHOOK_URL && node scripts/backfill-releases.js --run
 *
 * Required env vars:  GITLAB_TOKEN, GITLAB_PROJECT_ID
 * Also needed for --run: ANTHROPIC_API_KEY
 * Optional: GITLAB_SCOPE_PROJECT_ID, GITLAB_PROD_TAG_SUFFIX
 *
 * Load env: set -a && source .env.local && set +a
 */

import { spawnSync }        from "node:child_process";
import { fileURLToPath }    from "node:url";
import { dirname, join }    from "node:path";
import { getReleaseByTag }  from "../lib/gitlab.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Args ──────────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const flag   = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
const has    = (name) => args.includes(name);

const runMode    = has("--run");
const days       = flag("--days")  ? parseInt(flag("--days"),  10) : null;
const limit      = flag("--limit") ? parseInt(flag("--limit"), 10) : Infinity;
const scopeIdArg = flag("--scope-project-id") ?? process.env.GITLAB_SCOPE_PROJECT_ID ?? null;

// ── Env validation ────────────────────────────────────────────────────────────

const GITLAB_API = "https://gitlab.com/api/v4";
const token      = process.env.GITLAB_TOKEN;
const projectId  = process.env.GITLAB_PROJECT_ID;
const suffix     = process.env.GITLAB_PROD_TAG_SUFFIX || "-success-aws-prod-platform";

if (!token || !projectId) {
  console.error("ERROR: GITLAB_TOKEN and GITLAB_PROJECT_ID must be set.");
  console.error("  Run: set -a && source .env.local && set +a");
  process.exit(1);
}

if (runMode && !process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY must be set when using --run.");
  process.exit(1);
}

// ── Header ────────────────────────────────────────────────────────────────────

console.log(`\nLouisa backfill — project ${projectId}${scopeIdArg ? ` + scope ${scopeIdArg}` : ""}`);
console.log(runMode
  ? "Mode: RUN — will invoke generate-release-notes.js for each missing tag"
  : "Mode: DRY-RUN — pass --run to generate releases");
if (days)  console.log(`Scope: last ${days} days`);
if (limit < Infinity) console.log(`Limit: up to ${limit} tags`);
console.log();

// ── Fetch prod tags ───────────────────────────────────────────────────────────

console.log("Fetching prod tags from GitLab...");

const since   = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
const allTags = [];
let   page    = 1;

while (true) {
  const url = `${GITLAB_API}/projects/${encodeURIComponent(projectId)}/repository/tags` +
              `?per_page=100&page=${page}&order_by=updated&sort=desc`;
  const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  if (!res.ok) {
    console.error("Tags API error:", res.status, await res.text());
    process.exit(1);
  }
  const batch = await res.json();
  if (!batch.length) break;
  allTags.push(...batch);
  if (batch.length < 100) break;
  page++;
}

// Filter to prod tags, apply date window, sort newest-first for display
const prodTags = allTags
  .filter((t) => t.name.endsWith(suffix))
  .map((t) => ({ name: t.name, date: new Date(t.commit?.created_at || t.created_at) }))
  .sort((a, b) => b.date - a.date);

const inWindow = since ? prodTags.filter((t) => t.date >= since) : prodTags;
console.log(`Found ${inWindow.length} prod tag(s)${since ? ` since ${since.toISOString().slice(0, 10)}` : ""}\n`);

// ── Check each tag for an existing release ────────────────────────────────────

console.log("Checking for missing releases...\n");

const missing = [];
for (const t of inWindow) {
  const label = `  ${t.date.toISOString().slice(0, 10)}  ${t.name}`;
  process.stdout.write(label.padEnd(80));
  const release = await getReleaseByTag(projectId, t.name);
  if (release) {
    process.stdout.write("OK\n");
  } else {
    process.stdout.write("MISSING ✗\n");
    missing.push(t);
  }
}

console.log(`\n${missing.length} tag(s) missing a release.`);

if (missing.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

// Oldest-first for processing so getPreviousReleaseTag() finds earlier releases already created
const toProcess = [...missing].reverse().slice(0, limit);

console.log("\nWill process (oldest first):");
toProcess.forEach((t, i) => {
  console.log(`  ${String(i + 1).padStart(2)}. ${t.date.toISOString().slice(0, 10)}  ${t.name}`);
});

if (!runMode) {
  console.log("\nDry-run complete. Pass --run to generate release notes for each.");
  console.log("Tip: unset SLACK_WEBHOOK_URL first to suppress Slack notifications.");
  process.exit(0);
}

// ── Run generate-release-notes.js for each tag ───────────────────────────────

const scriptPath = join(__dirname, "generate-release-notes.js");
let succeeded = 0;
let failed    = 0;
const failures = [];

console.log(`\nStarting backfill run for ${toProcess.length} tag(s)...\n`);

for (let i = 0; i < toProcess.length; i++) {
  const t = toProcess[i];
  const bar = "─".repeat(60);
  console.log(bar);
  console.log(`[${i + 1}/${toProcess.length}]  ${t.name}`);
  console.log(bar);

  const spawnArgs = [
    scriptPath,
    "--tag",        t.name,
    "--project-id", projectId,
    ...(scopeIdArg ? ["--scope-project-id", scopeIdArg] : []),
  ];

  const result = spawnSync(process.execPath, spawnArgs, {
    stdio: "inherit",
    env:   process.env,
  });

  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `exit code ${result.status}`;
    console.error(`\nFAILED: ${t.name} — ${reason}`);
    failed++;
    failures.push({ tag: t.name, reason });
  } else {
    console.log(`\nOK: ${t.name}`);
    succeeded++;
  }

  console.log();
}

// ── Summary ───────────────────────────────────────────────────────────────────

const bar = "═".repeat(60);
console.log(bar);
console.log(`Backfill complete: ${succeeded} succeeded, ${failed} failed.`);

if (failures.length > 0) {
  console.log("\nFailed tags:");
  failures.forEach((f) => console.log(`  - ${f.tag}: ${f.reason}`));
}

if (succeeded > 0) {
  console.log("\nCommit the updated summaries log to preserve it for future releases:");
  console.log("  git add logs/ && git commit -m 'chore: backfill summaries' && git push");
}

process.exit(failed > 0 ? 1 : 0);
