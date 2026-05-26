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
   - Capability bullets: **Bold capability name.** *Italic sentence explaining the real-world benefit.*
   - Optional persona payoff: 2–3 lines on what this means for PMs / developers / compliance
   - **Sources line** (required for every feature section): on its own line at the end of the section, write \`**Sources:** (#123, #456, …)\` listing every PR number from the source release notes that this section draws from. A section may cite multiple PRs. Use ONLY PR numbers that appear in the provided release notes data — never invent or guess.
5. Enterprise / Infra Section (if applicable): tighter, "meeting teams where they are" framing — also ends with a **Sources:** line
6. Bug Fix / OSS Section (if applicable): short bullets with a brief human intro sentence — also ends with a **Sources:** line
7. Closing Section: mirror the opening tension, resolve it. Short declarative parallel sentences (e.g. "From reactive debugging to proactive insight. / From fragmented experimentation to reproducible evaluation."). End with a 1–2 sentence vision statement. No Sources line on the closing section.
8. PS — Always. Personal and casual, from Ashley. Reference something genuine about the release. Invite direct reply to ashley@arthur.ai. Include: "See the full platform release notes for [Month Year] here." with a link to https://docs.arthur.ai/changelog

SOURCE ATTRIBUTION RULES:
- The release notes provided below already attribute each bullet to a PR with \`(#<number>)\`. Treat these PR numbers as your source of truth.
- For each feature section in the blog, identify every PR from the release notes that contributed to the theme of that section and list them on the **Sources:** line.
- Format: \`**Sources:** (#123, #456, #789)\` — comma-separated, on its own line, immediately before the section's horizontal rule.
- A single PR may appear under multiple sections if it genuinely contributed to both.
- If a section has no traceable PR attribution in the source data, omit the **Sources:** line for that section rather than inventing numbers.

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
- Forgetting the **Sources:** line at the end of each feature section
- Inventing PR numbers that aren't present in the provided release notes`;

const releaseBlocks = releases
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

const userMessage = `Draft the Arthur monthly release blog post for ${month}.

Below are the release notes Louisa generated for every tag shipped this month. Use these as your source of truth for what was built.

${releaseBlocks}

INSTRUCTIONS:
- Identify the overarching narrative theme across all releases this month.
- Determine release size: Major, Mid-size, or Light.
- Draft the full blog post following the structure and voice in your instructions.
- For every feature section, end with a **Sources:** line listing the PR numbers (e.g. \`**Sources:** (#123, #456)\`) drawn from the \`(#<number>)\` attributions in the release notes above. A section may cite multiple PRs; one PR may appear in multiple sections.`;

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
      model:      "claude-sonnet-4-20250514",
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
