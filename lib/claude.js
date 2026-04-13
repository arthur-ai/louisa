import Anthropic from "@anthropic-ai/sdk";
import { getTracer, activeSpan } from "./otel.js";

// Lazily create the client so it is always constructed after
// AnthropicInstrumentation.manuallyInstrument() has patched the class
// (triggered by the first getTracer() call in the webhook handler).
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Call Claude to produce a compact, structured summary of a merged PR or MR.
 *
 * This runs at merge time and writes the result to the summaries log so that
 * release note generation can read pre-processed context instead of re-fetching
 * and re-analysing every PR at tag time.
 *
 * @param {object} opts
 * @param {"github"|"gitlab"} opts.platform
 * @param {string}   opts.title     - PR/MR title
 * @param {string}   opts.body      - PR/MR description (may be empty)
 * @param {Array<{sha:string, message:string, author:string}>}                          opts.commits
 * @param {Array<{filename:string, status:string, additions:number, deletions:number}>} opts.files
 * @param {string[]} opts.comments  - Significant review / discussion comment bodies
 *
 * @returns {Promise<{summary:string, type:string, userImpact:string}>}
 */
export async function summarizePR({ platform, title, body, commits, files, comments }) {
  const prLabel = platform === "github" ? "Pull Request" : "Merge Request";

  const systemPrompt = `You are Louisa, generating a compact ${prLabel} summary for a release notes changelog.

Given the title, description, commits, and changed files, produce a concise structured summary.

Return ONLY valid JSON — no markdown, no code fences, nothing else:
{
  "summary": "2-3 sentence description of what changed and why it matters to users or the system.",
  "type": "Feature|Enhancement|Bug Fix|Refactor|Internal|Breaking Change",
  "userImpact": "One sentence: what users can now do, or what previously broken behaviour now works correctly. Use 'No direct user impact' for purely internal changes."
}

Rules:
- Never invent claims not supported by the title, description, commits, or file list.
- Preserve the developer's intent. Do not reframe a bug fix as a feature.
- Be specific and concrete — this text feeds directly into release notes and marketing copy.
- For purely internal changes (CI, tests, refactors) use type=Internal.`;

  const filesSummary =
    files.length === 0
      ? "(no file data)"
      : files
          .slice(0, 30)
          .map((f) => `${f.status ?? "modified"} ${f.filename}  +${f.additions ?? 0}/-${f.deletions ?? 0}`)
          .join("\n");

  const commentsSummary =
    comments.length === 0
      ? "(no review comments)"
      : comments
          .slice(0, 10)
          .map((c, i) => `[Comment ${i + 1}]\n${c}`)
          .join("\n\n");

  const userContent = `${prLabel} title: ${title}

Description:
${body?.trim() || "(none)"}

Commits (${commits.length}):
${commits
  .slice(0, 40)
  .map((c) => `- ${c.sha}  ${c.message}  (${c.author})`)
  .join("\n")}

Files changed — ${files.length} total, showing up to 30:
${filesSummary}

Review highlights — ${comments.length} comment(s):
${commentsSummary}

Return the JSON summary now.`;

  const tracer = getTracer();
  const message = await activeSpan(tracer, "louisa.llm.summarize_pr", {
    "openinference.span.kind":              "LLM",
    "llm.model_name":                       "claude-opus-4-6",
    "llm.provider":                         "anthropic",
    "llm.invocation_parameters":            JSON.stringify({ model: "claude-opus-4-6", max_tokens: 512 }),
    "llm.input_messages.0.message.role":    "system",
    "llm.input_messages.0.message.content": systemPrompt,
    "llm.input_messages.1.message.role":    "user",
    "llm.input_messages.1.message.content": userContent,
    "input.value":                          JSON.stringify({ platform, title }),
    "input.mime_type":                      "application/json",
    "platform":                             platform,
  }, async (s) => {
    const msg = await getClient().messages.create({
      model: "claude-opus-4-6",
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });
    const responseText = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    s.setAttribute("llm.output_messages.0.message.role",    "assistant");
    s.setAttribute("llm.output_messages.0.message.content", responseText);
    s.setAttribute("llm.token_count.prompt",                msg.usage?.input_tokens ?? 0);
    s.setAttribute("llm.token_count.completion",            msg.usage?.output_tokens ?? 0);
    s.setAttribute("llm.token_count.total",                 (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0));
    s.setAttribute("output.value",                          responseText);
    s.setAttribute("output.mime_type",                      "text/plain");
    return msg;
  });

  const raw = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  try {
    const parsed = JSON.parse(raw);
    return {
      summary:    parsed.summary    || title,
      type:       parsed.type       || "Internal",
      userImpact: parsed.userImpact || "No direct user impact",
    };
  } catch {
    // If Claude returns malformed JSON, fall back to a plain summary
    console.warn("Louisa: summarizePR JSON parse failed, using raw text as summary");
    return { summary: raw.slice(0, 300), type: "Internal", userImpact: "No direct user impact" };
  }
}

export async function generateReleaseNotes({ tagName, releaseName, commits, pullRequests, previousTag }) {
  const systemPrompt = `You are Louisa, the release notes author for the Arthur Evals Engine.

Your job is to turn raw commit logs and pull request descriptions into polished,
compelling release notes aimed at **external users, developers, and stakeholders**
who use or evaluate the Arthur Engine.

## Output Format

Follow this EXACT structure:

# 🚀 Arthur Engine Release

**[Date]**

[1-2 sentence theme summary describing what this release means for users]

---

## [Section Title — grouped by product area]

### [Subsection — a specific feature or capability area]

* Bullet point describing user-facing change
* Another bullet point

[1-2 sentence paragraph summarizing the value of this section for users]

---

## Critical Rules

1. **NEVER include PR links, MR links, issue links, or commit references.** No PR numbers, no commit SHAs. These are internal and should never appear.

2. **Group by product area / functional domain**, NOT by change type.
   Good section titles: "Evaluation & Experiment Enhancements", "Trace Visibility & Debugging",
   "Deployment & Infrastructure Enhancements", "User Experience Improvements"
   Bad section titles: "New Features", "Bug Fixes", "Improvements"

3. **Use subsections (### H3) within sections** when there are distinct feature areas.

4. **Each section ends with a brief summary paragraph** (1-2 sentences)
   that explains the collective value of the changes for users.

5. **Use horizontal rules (---) between top-level sections.**

6. **Bold key feature names** inline within bullet points.
   Example: "* Added **system preferences for dark and light mode**"

7. The only emoji allowed is the rocket in the top-level heading.
   Do not use emojis in section titles, bullets, or anywhere else.

8. **Only include features and changes explicitly described in the provided commits and pull requests.** Do not infer, extrapolate, or invent capabilities not present in the source data. If something is not mentioned in the commits or PRs, do not include it in the release notes.

## Tone & Style

- Lead every bullet with the user benefit or capability added.
- Use active, clear language. Avoid jargon.
- Frame bug fixes as improvements: say what now works correctly, not what was broken.
- Omit purely internal refactors, CI pipeline changes, dependency bumps, and merge commits
  unless they have direct user-facing impact.
- If there are breaking changes, call them out in their own section at the top.
- Keep bullets concise — one line each when possible, two lines max.
- The theme summary at the top should tie together the overall release narrative.

## Output Rules
- Output valid GitHub-flavored Markdown.
- Do NOT wrap the output in a code fence. Return raw Markdown only.
- Start directly with the heading.`;

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const userContent = `Release: ${releaseName || tagName}
Tag: ${tagName}
Date: ${today}
${previousTag ? `Previous tag: ${previousTag}` : "First tracked release"}

Commits (${commits.length}):
${commits.map((c) => `- ${c.sha} ${c.message} (${c.author})`).join("\n")}

Merged Pull Requests (${pullRequests.length}):
${
  pullRequests.length === 0
    ? "No linked PRs found."
    : pullRequests
        .map(
          (pr) =>
            `PR #${pr.number}: ${pr.title}\n` +
            `Author: ${pr.author} | Labels: ${pr.labels.join(", ") || "none"}\n` +
            `${pr.body ? "Description:\n" + pr.body : "(no description)"}`
        )
        .join("\n\n")
}

Please write the release notes now. Remember: NO PR links, NO issue numbers, NO commit SHAs in the output.`;

  const tracer = getTracer();
  const message = await activeSpan(tracer, "louisa.llm.generate_release_notes", {
    "openinference.span.kind":              "LLM",
    "llm.model_name":                       "claude-opus-4-6",
    "llm.provider":                         "anthropic",
    "llm.invocation_parameters":            JSON.stringify({ model: "claude-opus-4-6", max_tokens: 4096 }),
    "llm.input_messages.0.message.role":    "system",
    "llm.input_messages.0.message.content": systemPrompt,
    "llm.input_messages.1.message.role":    "user",
    "llm.input_messages.1.message.content": userContent,
    "input.value":                          JSON.stringify({ tagName, previousTag: previousTag ?? null, commitCount: commits.length, prCount: pullRequests.length }),
    "input.mime_type":                      "application/json",
    "tag":                                  tagName,
    "previous_tag":                         previousTag ?? "",
    "commit_count":                         commits.length,
    "pr_count":                             pullRequests.length,
  }, async (s) => {
    const msg = await getClient().messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });
    const responseText = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    s.setAttribute("llm.output_messages.0.message.role",    "assistant");
    s.setAttribute("llm.output_messages.0.message.content", responseText);
    s.setAttribute("llm.token_count.prompt",                msg.usage?.input_tokens              ?? 0);
    s.setAttribute("llm.token_count.completion",            msg.usage?.output_tokens             ?? 0);
    s.setAttribute("llm.token_count.total",                 (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0));
    s.setAttribute("llm.token_count.cache_read",            msg.usage?.cache_read_input_tokens   ?? 0);
    s.setAttribute("llm.token_count.cache_write",           msg.usage?.cache_creation_input_tokens ?? 0);
    s.setAttribute("output.value",                          responseText.trim());
    s.setAttribute("output.mime_type",                      "text/markdown");
    return msg;
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return {
    text: text.trim(),
    usage: {
      inputTokens:      message.usage?.input_tokens              ?? 0,
      outputTokens:     message.usage?.output_tokens             ?? 0,
      totalTokens:      (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0),
      cacheReadTokens:  message.usage?.cache_read_input_tokens   ?? 0,
      cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}
