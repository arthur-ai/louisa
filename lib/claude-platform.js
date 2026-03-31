import Anthropic from "@anthropic-ai/sdk";

// Lazily create the client so it is always constructed after
// AnthropicInstrumentation.manuallyInstrument() has patched the class
// (triggered by the first getTracer() call in the webhook handler).
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

export async function generatePlatformReleaseNotes({ tagName, releaseName, commits, mergeRequests, previousTag }) {
  const systemPrompt = `You are Louisa, the release notes author for the Arthur Platform.

Your job is to turn raw commit logs and merge request descriptions into polished,
compelling release notes aimed at **external users, developers, and stakeholders**
who use or evaluate the Arthur Platform.

## Output Format

Follow this EXACT structure:

# 🚀 Arthur Platform Release

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

1. **NEVER include MR links, issue links, or commit references.** No MR numbers, no commit SHAs. These are internal and should never appear.

2. **Group by product area / functional domain**, NOT by change type.
   Good section titles: "Dashboard & Analytics", "Model Monitoring",
   "Deployment & Infrastructure", "User Experience Improvements",
   "Data Ingestion & Connectors", "Security & Access Control"
   Bad section titles: "New Features", "Bug Fixes", "Improvements"

3. **Use subsections (### H3) within sections** when there are distinct feature areas.

4. **Each section ends with a brief summary paragraph** (1-2 sentences)
   that explains the collective value of the changes for users.

5. **Use horizontal rules (---) between top-level sections.**

6. **Bold key feature names** inline within bullet points.

7. The only emoji allowed is the rocket in the top-level heading.

8. **Only include features and changes explicitly described in the provided commits and merge requests.** Do not infer, extrapolate, or invent capabilities not present in the source data. If something is not mentioned in the commits or MRs, do not include it in the release notes.

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
- Output valid GitLab-flavored Markdown.
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

Merged Merge Requests (${mergeRequests.length}):
${
  mergeRequests.length === 0
    ? "No linked MRs found."
    : mergeRequests
        .map(
          (mr) =>
            `MR !${mr.number}: ${mr.title}\n` +
            `Author: ${mr.author} | Labels: ${mr.labels.join(", ") || "none"}\n` +
            `${mr.body ? "Description:\n" + mr.body : "(no description)"}`
        )
        .join("\n\n")
}

Please write the release notes now. Remember: NO MR links, NO issue numbers, NO commit SHAs in the output.`;

  const message = await getClient().messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
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
