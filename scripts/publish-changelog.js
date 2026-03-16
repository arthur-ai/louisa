#!/usr/bin/env node
/**
 * Publish Arthur's combined monthly changelog to readme.io.
 *
 * Reads all releases for the given month from Louisa's release logs, calls
 * Claude to synthesize a structured changelog organized by Arthur Platform
 * and Arthur Engine & Toolkit, then creates or updates the entry on
 * docs.arthur.ai/changelog via the readme.io API.
 *
 * Usage:
 *   node scripts/publish-changelog.js "March 2026"
 *
 * Env vars required:
 *   README_API_KEY     — readme.io API key (from dash.readme.com → API Keys)
 *   ANTHROPIC_API_KEY  — Anthropic API key
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

// ── Load .env.local ───────────────────────────────────────────────────────────
// Must run before any env var reads. Uses the same parser as test-trace.js.
const __dir = dirname(fileURLToPath(import.meta.url));
try {
  const raw = readFileSync(resolve(__dir, "../.env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // File always wins — even if the key exists in env but is empty
    if (key && val) process.env[key] = val;
  }
} catch {
  // .env.local not found — rely on environment already being set
}

// ── Argument parsing ──────────────────────────────────────────────────────────

const month = process.argv[2];

if (!month) {
  console.error('Usage: node scripts/publish-changelog.js "March 2026"');
  process.exit(1);
}

if (!process.env.README_API_KEY) {
  console.error("README_API_KEY is not set. Add it to .env.local or your environment.");
  process.exit(1);
}

// ── Derive slugs and paths ────────────────────────────────────────────────────

// "March 2026" → "march-2026", "March 2026 Release Notes"
const monthSlug = month.toLowerCase().replace(/\s+/g, "-");
const title     = `${month} Release Notes`;
const root      = join(__dir, "..");
const logPath   = join(root, "logs", `releases-${monthSlug}.json.lines`);

// ── Load releases ─────────────────────────────────────────────────────────────

if (!existsSync(logPath)) {
  console.error(`No log file found for "${month}": ${logPath}`);
  console.error("Run scripts/backfill-log.js first to seed the log.");
  process.exit(1);
}

const releases = readFileSync(logPath, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (releases.length === 0) {
  console.error(`No releases found in ${logPath}.`);
  process.exit(1);
}

console.log(`Found ${releases.length} release(s) for ${month}`);

// ── Group releases by product ─────────────────────────────────────────────────

const groups = {};
for (const r of releases) {
  // Normalize to the two canonical product names used in the changelog
  const product = r.product.includes("Engine")
    ? "Arthur Engine & Toolkit"
    : "Arthur Platform";
  if (!groups[product]) groups[product] = [];
  groups[product].push(r);
}

// ── Build prompt ──────────────────────────────────────────────────────────────

const systemPrompt = `You are generating Arthur's monthly product changelog for docs.arthur.ai/changelog.

OUTPUT FORMAT — strictly follow this markdown structure:

## Arthur Platform
### [Functional Area, e.g. "Navigation & Interface"]
- **Feature name.** Brief description of the user benefit.
- **Another feature.** What it does and why it matters.

### [Another Area]
- ...

### Bug Fixes
- Brief description of what now works correctly.

---

## Arthur Engine & Toolkit
### [Functional Area]
- ...

### Bug Fixes
- ...

RULES:
- Two top-level sections only: Arthur Platform and Arthur Engine & Toolkit
- Use ### for functional groupings within each product (3–5 groups max)
- Each bullet: bold feature name + one sentence of user benefit
- Bug fixes go in their own ### subsection at the bottom of each product
- No marketing language, no internal PR/commit references, no narrative prose
- If only one product has releases this month, omit the other section
- Keep it concise — this is a reference document, not a blog post`;

const productBlocks = Object.entries(groups)
  .map(([product, entries]) => {
    const tags = entries.map((e) => e.tag).join(", ");
    const releaseDetails = entries
      .map(
        (r) =>
          `Tag: ${r.tag} | Theme: ${r.theme} | Key areas: ${r.keyAreas.join(", ")}
Notes:
${r.summary}
---`
      )
      .join("\n\n");
    return `Product: ${product}
Releases this month: ${tags}

${releaseDetails}`;
  })
  .join("\n\n");

const userMessage = `Generate the combined monthly changelog for ${month}.

${productBlocks}`;

// ── Call Claude ───────────────────────────────────────────────────────────────

const client = new Anthropic();

console.log("Calling Claude to synthesize changelog...");
const message = await client.messages.create({
  model:      "claude-sonnet-4-20250514",
  max_tokens: 4096,
  system:     systemPrompt,
  messages:   [{ role: "user", content: userMessage }],
});

const body = message.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("\n")
  .trim();

console.log(
  `Tokens used: ${message.usage.input_tokens} in, ${message.usage.output_tokens} out`
);

// ── Upsert to readme.io ───────────────────────────────────────────────────────

const readmeAuth = `Basic ${Buffer.from(`${process.env.README_API_KEY}:`).toString("base64")}`;
const readmeBase = "https://dash.readme.com/api/v1";

// Check for an existing entry with the same title
console.log(`Checking readme.io for existing entry: "${title}"...`);
const listRes = await fetch(`${readmeBase}/changelogs?perPage=100`, {
  headers: {
    Authorization: readmeAuth,
    Accept:        "application/json",
  },
});

if (!listRes.ok) {
  const errText = await listRes.text();
  console.error(`readme.io GET /changelogs failed: ${listRes.status} — ${errText}`);
  process.exit(1);
}

const changelogs = await listRes.json();
const existing   = changelogs.find((c) => c.title === title);

const payload = { title, body, type: "improved", hidden: false };

let response;
if (existing) {
  console.log(`Found existing entry (slug: ${existing.slug}) — updating...`);
  response = await fetch(`${readmeBase}/changelogs/${existing.slug}`, {
    method:  "PUT",
    headers: { Authorization: readmeAuth, "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });
} else {
  console.log("No existing entry found — creating...");
  response = await fetch(`${readmeBase}/changelogs`, {
    method:  "POST",
    headers: { Authorization: readmeAuth, "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });
}

if (!response.ok) {
  const errText = await response.text();
  console.error(
    `readme.io ${existing ? "PUT" : "POST"} failed: ${response.status} — ${errText}`
  );
  process.exit(1);
}

const result    = await response.json();
const entrySlug = result.slug || existing?.slug || monthSlug;

console.log(`\n✓ ${existing ? "Updated" : "Published"}: ${title}`);
console.log(`  https://docs.arthur.ai/changelog/${entrySlug}`);
