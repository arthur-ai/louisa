import Anthropic from "@anthropic-ai/sdk";

// Lazily create the client so it is always constructed after
// AnthropicInstrumentation.manuallyInstrument() has patched the class.
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Sentinel comment embedded in every enriched description.
 * Invisible when rendered as Markdown; detectable in raw text.
 */
export const ENRICHMENT_MARKER = "<!-- enriched-by-louisa -->";

/**
 * Returns true if a PR/MR body has already been enriched by Louisa.
 * @param {string|null|undefined} body
 */
export function isAlreadyEnriched(body) {
  return typeof body === "string" && body.includes(ENRICHMENT_MARKER);
}

/**
 * Call Claude to produce an enriched PR/MR title and structured description.
 *
 * The enriched description uses a consistent schema designed so that when
 * Louisa later reads PR/MR bodies during release note generation she gets
 * clearly labelled, high-signal context for every section: user impact,
 * breaking changes, change type, and affected areas.
 *
 * @param {object}   opts
 * @param {"github"|"gitlab"} opts.platform
 * @param {string}   opts.originalTitle   - Developer's original title
 * @param {string}   opts.originalBody    - Developer's original description (may be empty)
 * @param {Array<{sha:string, message:string, author:string}>} opts.commits
 * @param {Array<{filename:string, status:string, additions:number, deletions:number}>} opts.files
 * @param {string[]} opts.comments        - Significant review / discussion comment bodies
 *
 * @returns {Promise<{title:string, body:string, usage:{inputTokens:number, outputTokens:number}}>}
 */
export async function enrichPRDescription({
  platform,
  originalTitle,
  originalBody,
  commits,
  files,
  comments,
}) {
  const prLabel = platform === "github" ? "Pull Request" : "Merge Request";

  const systemPrompt = `You are Louisa, enriching a ${prLabel} title and description so that downstream release note generation and marketing copy have richer, more consistent context to work from.

Your task: rewrite the ${prLabel} title and a structured description using the developer's original content as the primary source of truth, supplemented by the commit history, changed files, and review discussion.

## Output format

Return EXACTLY the following — the enriched title on the FIRST LINE, then a blank line, then the description body. No other text.

[Enriched title — concise, ≤60 chars, suitable for a changelog entry]

## Summary
[1–2 sentences describing what this change does and why it matters. Lead with the outcome for users or the system, not the implementation detail.]

## Problem
[The specific friction, gap, or failure mode this change addresses. Be concrete. One short paragraph.]

## Solution
[What was built to fix it. One short paragraph. Name key implementation approaches only when they affect user-facing behaviour or future extensibility.]

## User Impact
[The most important section. What can users now do, see, or rely on that they couldn't before? Or what previously broken behaviour now works correctly? This section feeds directly into external-facing release notes — make it substantive.]

## Changed Areas
[Bullet list of the most significant module/feature areas touched (not raw file paths). Describe what each area does functionally. Skip trivial changes: tests, CI configs, docs, dependency bumps. Max 8 bullets.]

## Type
[Exactly one of: Feature | Enhancement | Bug Fix | Breaking Change | Refactor | Internal]

## Breaking Changes
[Either "None" or a clear, migration-ready description of what breaks and how consumers should update.]

${ENRICHMENT_MARKER}

## Rules
- NEVER invent claims not supported by the title, description, commits, or file list.
- Preserve the developer's intent. Do not reframe a bug fix as a feature.
- If the change is purely internal with no user-visible effect, say so in User Impact and set Type to Refactor or Internal.
- Keep every section brief and scannable — this is structured metadata, not an essay.
- The enriched title must be in plain text (no markdown).`;

  // Build the context block for Claude
  const filesSummary =
    files.length === 0
      ? "(no file data)"
      : files
          .slice(0, 40)
          .map(
            (f) =>
              `${f.status ?? "modified"} ${f.filename}  +${f.additions ?? 0}/-${f.deletions ?? 0}`
          )
          .join("\n");

  const commentsSummary =
    comments.length === 0
      ? "(no review comments)"
      : comments
          .slice(0, 15)
          .map((c, i) => `[Comment ${i + 1}]\n${c}`)
          .join("\n\n");

  const userContent = `Original ${prLabel} title: ${originalTitle}

Original description:
${originalBody?.trim() || "(none)"}

Commits (${commits.length}):
${commits
  .slice(0, 60)
  .map((c) => `- ${c.sha}  ${c.message}  (${c.author})`)
  .join("\n")}

Files changed — ${files.length} total, showing up to 40:
${filesSummary}

Review / discussion highlights — ${comments.length} comment(s):
${commentsSummary}

Now produce the enriched title (line 1) and structured description. Follow the format exactly.`;

  const message = await getClient().messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });

  const raw = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Split: first non-empty line → enriched title; everything after the blank
  // separator line → enriched body.
  const lines = raw.split("\n");
  const firstNonEmpty = lines.findIndex((l) => l.trim().length > 0);
  const enrichedTitle =
    firstNonEmpty >= 0 ? lines[firstNonEmpty].trim() : originalTitle;
  const body = lines
    .slice(firstNonEmpty + 1)
    .join("\n")
    .trim();

  return {
    title: enrichedTitle,
    body,
    usage: {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    },
  };
}
