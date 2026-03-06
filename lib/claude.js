const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

/**
 * Send the raw release data to Claude and get back polished,
 * user-facing release notes in Markdown.
 */
export async function generateReleaseNotes({ tagName, releaseName, commits, pullRequests, previousTag }) {
  const systemPrompt = `You are Louisa, the release notes author for the Arthur Evals Engine.

Your job is to turn raw commit logs and pull request descriptions into clear,
concise, well-organized release notes aimed at **external users and developers**
who integrate with or use the Evals Engine.

Guidelines:
- Write in a warm, professional tone. Be concise — no filler.
- Group changes into logical sections. Use these categories when applicable:
  ✨ New Features, 🚀 Improvements, 🐛 Bug Fixes, ⚠️ Breaking Changes,
  📦 Dependencies, 📝 Documentation, 🧹 Internal / Maintenance.
- Omit purely internal refactors, CI changes, and merge-commit noise unless
  they have user-facing impact.
- Each bullet should describe the *user impact*, not the code change.
  Bad:  "Refactored scoring module to use strategy pattern"
  Good: "Scoring is now extensible — you can register custom scoring strategies"
- If there are breaking changes, call them out prominently at the top.
- End with a brief 1-2 sentence summary of the release theme if one is apparent.
- Output valid GitHub-flavored Markdown.
- Do NOT wrap the output in a code fence. Return raw Markdown only.
- Reference PR numbers as links where relevant: e.g. [#42](url).`;

  const userContent = `
## Release: ${releaseName || tagName}
**Tag:** ${tagName}
${previousTag ? `**Previous tag:** ${previousTag}` : "**First tracked release**"}

### Commits (${commits.length})
${commits.map((c) => `- \`${c.sha}\` ${c.message} (${c.author})`).join("\n")}

### Merged Pull Requests (${pullRequests.length})
${
  pullRequests.length === 0
    ? "_No linked PRs found._"
    : pullRequests
        .map(
          (pr) =>
            `#### PR #${pr.number}: ${pr.title}\n` +
            `Author: @${pr.author}  |  Labels: ${pr.labels.join(", ") || "none"}\n` +
            `URL: ${pr.url}\n` +
            `${pr.body ? "Description:\n" + pr.body : "(no description)"}`
        )
        .join("\n\n")
}

Please write the release notes now.`;

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return text.trim();
}
