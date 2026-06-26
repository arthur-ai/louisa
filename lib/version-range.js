/**
 * Intent parsing and release-range selection for the Slack @mention bot.
 *
 * The bot answers "what changed between version X and version Y?" for either
 * product. This module turns free-form mention text into a structured intent,
 * and selects the set of published releases that fall between two versions.
 */

// A version token: 1.2.3, 1.4.1892, optionally with extra dotted segments and a
// trailing tag suffix (e.g. 1.4.1892-success-aws-prod-platform). We capture the
// numeric core and let normalization handle product-specific suffixes/prefixes.
const VERSION_RE = /v?\d+\.\d+(?:\.\d+)*(?:[-.][A-Za-z0-9-]+)*/g;

/**
 * Parse an @mention into an intent.
 *
 * Detects the product (platform/gitlab → "platform"; engine/github → "engine")
 * and the two version tokens. Tolerant of phrasing such as "between X and Y"
 * or "from X to Y". Returns null when it can't find a product + two versions —
 * the caller should then post a usage hint.
 *
 * @param {string} text - mention text WITH the leading <@BOTID> already stripped
 * @returns {{product:"platform"|"engine", v1:string, v2:string} | null}
 */
export function parseMentionIntent(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  let product = null;
  if (/\b(platform|gitlab)\b/.test(lower)) product = "platform";
  else if (/\b(engine|github)\b/.test(lower)) product = "engine";
  if (!product) return null;

  const versions = text.match(VERSION_RE);
  if (!versions || versions.length < 2) return null;

  // First two version-like tokens, in the order written.
  return { product, v1: versions[0], v2: versions[1] };
}

/**
 * Normalize a user-supplied version to the canonical tag for a product.
 * - platform: ensure the prod tag suffix is present.
 * - engine:   strip an optional leading "v".
 */
export function normalizeVersion(product, version, prodSuffix) {
  const v = version.trim();
  if (product === "platform") {
    return v.endsWith(prodSuffix) ? v : `${v}${prodSuffix}`;
  }
  return v.replace(/^v/i, "");
}

/**
 * Select the releases that fall between two versions, ordered oldest→newest.
 *
 * `releases` must be sorted newest-first and shaped as { name, body, date }.
 * (lib/github.js#listReleasesSorted returns { tag_name, body, date }; the caller
 * maps tag_name→name before calling.)
 *
 * Selection rule: everything the customer doesn't yet have, up to and including
 * the target — date > date(v1) and date <= date(v2). If v1/v2 are reversed,
 * they are swapped. Versions not found are reported with the nearest tags.
 *
 * @returns {{ok:true, releases:Array<{name,body,date}>, from:string, to:string}
 *          | {ok:false, error:string}}
 */
export function selectReleasesBetween(releases, v1, v2) {
  const byName = new Map(releases.map((r) => [r.name, r]));

  const nearest = () =>
    releases.slice(0, 8).map((r) => r.name).join("\n") || "(none found)";

  const a = byName.get(v1);
  const b = byName.get(v2);
  if (!a) return { ok: false, error: `Couldn't find version \`${v1}\`. Recent releases:\n${nearest()}` };
  if (!b) return { ok: false, error: `Couldn't find version \`${v2}\`. Recent releases:\n${nearest()}` };

  // Order so `older` is the version the customer runs and `newer` is the target.
  let older = a;
  let newer = b;
  if (older.date > newer.date) [older, newer] = [newer, older];

  if (older.name === newer.name) {
    return { ok: false, error: "Both versions are the same — there's nothing between them." };
  }

  const selected = releases
    .filter((r) => r.date > older.date && r.date <= newer.date)
    .sort((x, y) => x.date - y.date); // oldest → newest

  if (selected.length === 0) {
    return { ok: false, error: `No releases found between \`${older.name}\` and \`${newer.name}\`.` };
  }

  return { ok: true, releases: selected, from: older.name, to: newer.name };
}

/**
 * Concatenate selected releases into labeled changelog sections for Claude.
 */
export function concatReleaseNotes(selected) {
  return selected
    .map((r) => `## ${r.name}\n\n${(r.body || "").trim() || "(no release notes)"}`)
    .join("\n\n---\n\n");
}
