const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

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
