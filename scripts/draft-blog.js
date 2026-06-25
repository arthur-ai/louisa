#!/usr/bin/env node
/**
 * Draft the Arthur monthly release blog post from Louisa's release logs.
 *
 * Usage:
 *   node scripts/draft-blog.js "March 2026"           # reads logs/releases-march-2026.json.lines
 *   node scripts/draft-blog.js "March 2026" --days 30 # reads last 30 days across all log files
 *
 * Outputs: output/blog-draft-march-2026.md
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { getTracer, activeSpan, forceFlush } from "../lib/otel.js";

// Initialise OTel provider + Anthropic auto-instrumentation before the
// Anthropic client is constructed so the messages.create() call below
// becomes an auto-instrumented LLM child span.
const tracer = getTracer();

// ── Argument parsing ──────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const daysIdx = rawArgs.indexOf("--days");
const days    = daysIdx !== -1 ? parseInt(rawArgs[daysIdx + 1], 10) : null;

// Positional args: everything that isn't a flag or the value after --days
const positional = rawArgs.filter(
  (a, i) => !a.startsWith("--") && i !== daysIdx + 1
);
const month = positional[0];

if (!month) {
  console.error('Usage: node scripts/draft-blog.js "March 2026" [--days 30]');
  process.exit(1);
}

// "March 2026" → "march-2026"
const monthSlug = month.toLowerCase().replace(/\s+/g, "-");
const root      = join(new URL(import.meta.url).pathname, "../..");
const logsDir   = join(root, "logs");

// ── Load releases ─────────────────────────────────────────────────────────────

let releases;

if (days != null) {
  // --days mode: scan all log files, filter by timestamp
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  console.log(
    `Reading last ${days} days of releases (since ${since.toISOString().slice(0, 10)})...`
  );

  if (!existsSync(logsDir)) {
    console.error(`No logs directory found: ${logsDir}`);
    console.error("Run scripts/backfill-log.js first to seed the log.");
    process.exit(1);
  }

  releases = [];
  for (const file of readdirSync(logsDir).filter((f) => f.endsWith(".json.lines"))) {
    for (const line of readFileSync(join(logsDir, file), "utf-8").split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (new Date(entry.timestamp) >= since) releases.push(entry);
      } catch {}
    }
  }

  // Oldest first so Claude sees the narrative arc as it built through the month
  releases.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
} else {
  // Default: read the single monthly log file
  const logPath = join(logsDir, `releases-${monthSlug}.json.lines`);
  if (!existsSync(logPath)) {
    console.error(`No log file found for "${month}": ${logPath}`);
    console.error(
      'Run scripts/backfill-log.js first, or use --days 30 to read across log files.'
    );
    process.exit(1);
  }

  releases = readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

if (releases.length === 0) {
  console.error(`No releases found for the requested window.`);
  process.exit(1);
}

console.log(`Found ${releases.length} release(s) — drafting "${month}" blog post`);

// ── Resolve PR → URL links ────────────────────────────────────────────────────

const REPO_OWNER = process.env.REPO_OWNER || process.env.GITHUB_REPO_OWNER;
const REPO_NAME  = process.env.REPO_NAME  || process.env.GITHUB_REPO_NAME;

async function fetchGitLabProjectUrl(projectId) {
  const token = process.env.GITLAB_TOKEN;
  if (!token || !projectId) return null;
  const res = await fetch(`https://gitlab.com/api/v4/projects/${projectId}`, {
    headers: { "PRIVATE-TOKEN": token },
  });
  if (!res.ok) return null;
  return (await res.json()).web_url;
}

// Resolve each GitLab project's web_url once. GitLab MR URLs require the
// project's group/path, which the numeric GITLAB_PROJECT_ID alone doesn't give.
const gitlabWebUrl = await fetchGitLabProjectUrl(process.env.GITLAB_PROJECT_ID);

function buildPrUrlMap(release) {
  // GitHub release notes attribute MRs with (#N); GitLab uses (!N). Match both.
  const nums = [
    ...new Set(
      [...release.summary.matchAll(/\((?:#|!)(\d+)\)/g)].map((m) => m[1])
    ),
  ];
  const map = {};
  if (release.product === "Arthur Engine" && REPO_OWNER && REPO_NAME) {
    for (const n of nums) {
      map[n] = `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${n}`;
    }
  } else if (release.product === "Arthur Platform" && gitlabWebUrl) {
    // MR iids are project-scoped; when GITLAB_SCOPE_PROJECT_ID is also set
    // some MRs may actually belong to that project. Default to primary —
    // the human reviewing the draft fixes any wrong links.
    for (const n of nums) {
      map[n] = `${gitlabWebUrl}/-/merge_requests/${n}`;
    }
  }
  return map;
}

console.log("Building PR URL lookup for source attribution...");
const releasesWithLinks = releases.map((r) => ({ ...r, prUrls: buildPrUrlMap(r) }));
const totalLinks = releasesWithLinks.reduce(
  (n, r) => n + Object.keys(r.prUrls).length,
  0
);
console.log(`Built ${totalLinks} PR URL(s)`);

// ── Build prompt ──────────────────────────────────────────────────────────────

const systemPrompt = `You are drafting Arthur's monthly product release blog post, written in the voice of Ashley Nader, Arthur's product storyteller.

VOICE & TONE:
- Confident, not hype-y. Name real pain before introducing solutions.
- Short punchy sentences for problem statements. Slightly longer for explanations.
- Direct and second-person ("your team," "you can now").
- Human personality where it fits. Never corporate.
- Never lead with features. Always lead with friction.

PERSONAS to address across the post:
- PMs: visibility into agent behavior, measurable outcomes, shipping safely
- Developers: debug speed, integration flexibility, no forced rewrites
- Compliance / Governance: oversight without creating bottlenecks

STRUCTURE TO FOLLOW:
1. Title — Punchy, tension-driven. Often a transformation ("From X to Y") or a promise. Reflects the month's theme.
2. Subtitle — Always exactly: "Arthur Platform Release – [Month Year] Edition"
3. Opening Hook (2–4 short paragraphs) — Name the real-world problem space. No feature names. End with a one-sentence bridge to what this release does about it.
4. Feature Sections (one H2 per major feature or theme):
   - Problem framing (2–4 sentences): what's broken or hard today, specifically
   - What Arthur built: introduce the feature name in bold
   - Capability bullets: **Bold capability name.** *Italic sentence explaining the real-world benefit.* Each bullet MUST end with its own inline source attribution — see SOURCE ATTRIBUTION RULES below.
   - Optional persona payoff: 2–3 lines on what this means for PMs / developers / compliance
5. Enterprise / Infra Section (if applicable): tighter, "meeting teams where they are" framing — bullets still carry inline source attribution
6. Bug Fix / OSS Section (if applicable): short bullets with a brief human intro sentence — bullets still carry inline source attribution
7. Closing Section: mirror the opening tension, resolve it. Short declarative parallel sentences (e.g. "From reactive debugging to proactive insight. / From fragmented experimentation to reproducible evaluation."). End with a 1–2 sentence vision statement. No source attribution on the closing section.
8. PS — Always. Personal and casual, from Ashley. Reference something genuine about the release. Invite direct reply to ashley@arthur.ai. Include: "See the full platform release notes for [Month Year] here." with a link to https://docs.arthur.ai/changelog

SOURCE ATTRIBUTION RULES:
- The release notes provided below already attribute each bullet to a PR or MR. **GitHub PRs use \`(#<number>)\` (hash); GitLab MRs use \`(!<number>)\` (bang).** Treat these numbers as your source of truth — these are the ONLY valid PR numbers. Never invent numbers from version tags (e.g. \`1.4.2164\` does NOT mean PR #2164) or anywhere else.
- Attribute sources **inline at the end of each bullet point**, not in a section-level Sources line. Do NOT emit a \`**Sources:**\` line at the end of any section.
- Format: regardless of source format, render every link as \`[#<number>](URL)\`. End each bullet with one or more markdown-linked PR references in parentheses, e.g. \`* **Capability name.** *Benefit explanation.* ([#123](URL), [#456](URL))\`.
- A bullet may cite multiple PRs if more than one genuinely contributed to that specific capability. List only PRs that informed THAT bullet — never reuse the same PR across unrelated bullets, and never lump every PR from a section into every bullet.
- The URL for each PR MUST come from the PR LINK TABLE provided in the user message. Do not fabricate URLs. If a PR number is not in the table, render it as plain \`#<number>\` without a link rather than guessing.
- If a specific bullet has no traceable PR attribution in the source data, omit the inline citation for that bullet rather than inventing numbers.

SCALE BY RELEASE SIZE:
- Major: Long-form, 5–8 sections, rich persona callouts, big-picture industry framing in the hook
- Mid-size: 3–5 thematic sections grouping related features, 3–4 specific friction points in the hook
- Light: 2–3 sections, lean into a teaser if a major release is coming, include OSS/fix bullets

AVOID:
- Opening with a feature name
- Vague AI hype without grounding ("revolutionary," "game-changing")
- Bullets that describe a thing without stating a benefit
- Closing that reads like a summary instead of a narrative landing
- Forgetting the PS
- Emitting a section-level \`**Sources:**\` line (sources go inline on each bullet)
- Duplicating the same PR across every bullet in a section — attribute each PR only to the specific bullet(s) it contributed to
- Inventing PR numbers or URLs that aren't present in the provided release notes or PR LINK TABLE
- Pulling numbers from version tags (e.g. \`1.4.2164\`) and citing them as PR numbers — version components are NOT PR numbers`;

const releaseBlocks = releasesWithLinks
  .map(
    (r) => `Release: ${r.tag} — ${r.product}
Theme: ${r.theme}
Key areas: ${r.keyAreas.join(", ")}
Breaking changes: ${r.breakingChanges || "None"}
Full notes:
${r.summary}
---`
  )
  .join("\n\n");

const prLinkTable = releasesWithLinks
  .map((r) => {
    const entries = Object.entries(r.prUrls);
    if (entries.length === 0) return null;
    const lines = entries
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([n, url]) => `  #${n} → ${url}`)
      .join("\n");
    return `Release: ${r.tag} — ${r.product}\n${lines}`;
  })
  .filter(Boolean)
  .join("\n\n");

const userMessage = `Draft the Arthur monthly release blog post for ${month}.

Below are the release notes Louisa generated for every tag shipped this month. Use these as your source of truth for what was built.

${releaseBlocks}

PR LINK TABLE:
Use these URLs to render each inline PR attribution as a markdown link. The table covers both GitHub PRs (originally written as \`(#N)\` in the release notes) and GitLab MRs (originally written as \`(!N)\`). Regardless of source format, output \`[#<number>](<url>)\`. If a PR number is not in this table, render it as plain \`#<number>\` without a link.

${prLinkTable || "(no PR URLs resolved — render PR numbers as plain #<number>)"}

INSTRUCTIONS:
- Identify the overarching narrative theme across all releases this month.
- Determine release size: Major, Mid-size, or Light.
- Draft the full blog post following the structure and voice in your instructions.
- Attribute sources **inline at the end of every capability bullet**, citing only the PR(s) that contributed to that specific bullet. Example: \`* **Trace search.** *Find any span across a week in seconds.* ([#123](https://github.com/owner/repo/pull/123), [#456](https://gitlab.com/group/proj/-/merge_requests/456))\`
- Do NOT emit a section-level \`**Sources:**\` line. Do NOT repeat the same PR across unrelated bullets. URLs MUST come from the PR LINK TABLE.`;

// ── Call Claude (root CHAIN — session = month slug) ──────────────────────────

const client = new Anthropic();

try {
  await activeSpan(tracer, "louisa.draft_blog", {
    "openinference.span.kind": "CHAIN",
    "session.id":              monthSlug,
    "input.value":             JSON.stringify({ month, monthSlug, releaseCount: releases.length, days: days ?? null }),
    "input.mime_type":         "application/json",
    "month":                   month,
    "month_slug":              monthSlug,
    "release_count":           releases.length,
  }, async (rootSpan) => {
    console.log("Calling Claude to draft blog post...");
    const message = await client.messages.create({
      model:      "claude-opus-4-8",
      max_tokens: 8192,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userMessage }],
    });

    const draft = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    // ── Write output ────────────────────────────────────────────────────────────

    const outputDir  = join(root, "output");
    mkdirSync(outputDir, { recursive: true });

    const outputPath = join(outputDir, `blog-draft-${monthSlug}.md`);
    writeFileSync(outputPath, draft);

    console.log(`\nBlog draft written to: ${outputPath}`);
    console.log(
      `Tokens used: ${message.usage.input_tokens} in, ${message.usage.output_tokens} out`
    );

    rootSpan.setAttribute("output.value", JSON.stringify({
      outputPath,
      draftLength:  draft.length,
      inputTokens:  message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    }));
    rootSpan.setAttribute("output.mime_type", "application/json");
  });
} finally {
  await forceFlush();
}
