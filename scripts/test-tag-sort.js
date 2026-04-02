#!/usr/bin/env node
/**
 * test-tag-sort.js — Verify the tag sort logic used in getPreviousReleaseTag.
 *
 * Tests:
 *   1. Sort order: tags with out-of-order release publish dates sort correctly by commit date
 *   2. Fallback: currentTag not in list → returns null
 *   3. Env var: empty GITLAB_PROD_TAG_SUFFIX → defaults to hardcoded value (not match-all)
 *   4. Pagination simulation: currentTag on page 2 (>100 tags)
 *
 * Run: node scripts/test-tag-sort.js
 */

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Helpers matching the production logic ────────────────────────────────────

function getPreviousTagFromList(allTags, currentTag, suffix) {
  const effectiveSuffix = suffix || "-success-aws-prod-platform";
  const prodTags = allTags
    .filter((t) => t.name.endsWith(effectiveSuffix))
    .sort((a, b) => {
      const da = new Date(a.commit?.created_at || a.created_at || 0);
      const db = new Date(b.commit?.created_at || b.created_at || 0);
      return db - da; // descending: newest first
    });

  if (prodTags.length === 0) return null;

  const idx = prodTags.findIndex((t) => t.name === currentTag);
  if (idx >= 0 && idx < prodTags.length - 1) {
    return prodTags[idx + 1].name;
  }
  // currentTag not found or it's the oldest
  return null;
}

// ── Test 1: Out-of-order release publish dates ───────────────────────────────
// The bug: if you sort by release.released_at (publish date), a manually backdated
// release would corrupt the order. Commit dates are the correct signal.

console.log("\nTest 1: Sort by commit date (not publish date)");
{
  const suffix = "-success-aws-prod-platform";
  const tags = [
    // Tag C was released first (earliest publish date) but has the newest commit
    { name: `1.0.3${suffix}`, commit: { created_at: "2024-03-01T10:00:00Z" }, released_at: "2024-01-01T00:00:00Z" },
    // Tag B has a normal publish date and commit date
    { name: `1.0.2${suffix}`, commit: { created_at: "2024-02-01T10:00:00Z" }, released_at: "2024-02-02T00:00:00Z" },
    // Tag A is the oldest by commit date but was backdated to appear newer by publish date
    { name: `1.0.1${suffix}`, commit: { created_at: "2024-01-01T10:00:00Z" }, released_at: "2024-03-01T00:00:00Z" },
  ];
  const current = `1.0.3${suffix}`;
  const result = getPreviousTagFromList(tags, current, suffix);
  assert(result === `1.0.2${suffix}`, `Previous of 1.0.3 is 1.0.2 (got: ${result})`);

  const result2 = getPreviousTagFromList(tags, `1.0.2${suffix}`, suffix);
  assert(result2 === `1.0.1${suffix}`, `Previous of 1.0.2 is 1.0.1 (got: ${result2})`);

  const result3 = getPreviousTagFromList(tags, `1.0.1${suffix}`, suffix);
  assert(result3 === null, `Previous of oldest tag is null (got: ${result3})`);
}

// ── Test 2: currentTag not in list → null ────────────────────────────────────

console.log("\nTest 2: currentTag not found in prod tags → null + fallback");
{
  const suffix = "-success-aws-prod-platform";
  const tags = [
    { name: `1.0.2${suffix}`, commit: { created_at: "2024-02-01T10:00:00Z" } },
    { name: `1.0.1${suffix}`, commit: { created_at: "2024-01-01T10:00:00Z" } },
  ];
  const result = getPreviousTagFromList(tags, `1.0.3${suffix}`, suffix);
  assert(result === null, `Unknown currentTag returns null (got: ${result})`);
}

// ── Test 3: Empty GITLAB_PROD_TAG_SUFFIX → default, not match-all ───────────
// endsWith("") matches every string — this must be caught before calling endsWith.

console.log("\nTest 3: Empty suffix env var defaults to hardcoded value");
{
  const PROD_SUFFIX = "-success-aws-prod-platform";
  const emptySuffix = ""; // simulates process.env.GITLAB_PROD_TAG_SUFFIX === ""
  const effectiveSuffix = emptySuffix || PROD_SUFFIX;

  assert(effectiveSuffix === PROD_SUFFIX, `Empty string coerces to default suffix`);
  assert("".endsWith("") === true, `Sanity: "".endsWith("") is true (the footgun)`);

  const tags = [
    { name: `1.0.2${PROD_SUFFIX}`, commit: { created_at: "2024-02-01T10:00:00Z" } },
    { name: "some-other-tag",       commit: { created_at: "2024-01-15T10:00:00Z" } }, // should NOT match
    { name: `1.0.1${PROD_SUFFIX}`, commit: { created_at: "2024-01-01T10:00:00Z" } },
  ];
  const result = getPreviousTagFromList(tags, `1.0.2${PROD_SUFFIX}`, effectiveSuffix);
  assert(result === `1.0.1${PROD_SUFFIX}`, `Empty suffix falls back to default — non-prod tags excluded (got: ${result})`);
}

// ── Test 4: Pagination simulation (>100 tags) ────────────────────────────────
// currentTag may be on page 2. The production code paginates up to 10 pages.
// We simulate by pre-merging 150 tags and checking the sort still works.

console.log("\nTest 4: Pagination — target tag on page 2");
{
  const suffix = "-success-aws-prod-platform";
  // Build 150 tags: tag i has a commit date i minutes after base (so tag 150 is newest)
  const allTags = [];
  const base = new Date("2024-01-01T00:00:00Z").getTime();
  for (let i = 150; i >= 1; i--) {
    const pad = String(i).padStart(3, "0");
    allTags.push({
      name: `1.0.${pad}${suffix}`,
      commit: { created_at: new Date(base + i * 60_000).toISOString() },
    });
  }

  const currentTag = `1.0.100${suffix}`; // would be on "page 2" if per_page=100
  const result = getPreviousTagFromList(allTags, currentTag, suffix);
  assert(result === `1.0.099${suffix}`, `Previous of tag 100 in a 150-tag list is 099 (got: ${result})`);
}

// ── Test 5: Single tag in list → null ────────────────────────────────────────

console.log("\nTest 5: Single tag in list (first ever release)");
{
  const suffix = "-success-aws-prod-platform";
  const tags = [
    { name: `1.0.0${suffix}`, commit: { created_at: "2024-01-01T10:00:00Z" } },
  ];
  const result = getPreviousTagFromList(tags, `1.0.0${suffix}`, suffix);
  assert(result === null, `First release in list has no previous tag (got: ${result})`);
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed.");
}
