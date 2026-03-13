#!/usr/bin/env node
/**
 * Generates a customer-facing summary of Arthur Platform changes between two prod tags.
 * Optionally also pulls commits from a second project (e.g. frontend) by date range.
 * Output is printed only — nothing is published.
 *
 * Usage:
 *   node scripts/customer-summary.js <projectId> <fromTag> <toTag> [frontendProjectId] [since]
 *
 * Example:
 *   node scripts/customer-summary.js 48008591 1.4.1777-success-aws-prod-platform 1.4.1901-success-aws-prod-platform 54848372 2026-01-31
 */

import Anthropic from "@anthropic-ai/sdk";
import { getCommitsBetweenTags, getMergeRequestsForCommits } from "../lib/gitlab.js";

const GITLAB_API = "https://gitlab.com/api/v4";
function glHeaders() {
  return { "PRIVATE-TOKEN": process.env.GITLAB_TOKEN };
}

async function getCommitsSince(projectId, since) {
  const allCommits = [];
  let page = 1;
  while (true) {
    const url = `${GITLAB_API}/projects/${projectId}/repository/commits?since=${since}T00:00:00Z&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: glHeaders() });
    if (!res.ok) break;
    const batch = await res.json();
    if (!batch.length) break;
    allCommits.push(...batch.map(c => ({
      sha: (c.id || c.short_id || "").slice(0, 8),
      message: (c.title || c.message || "").split("\n")[0],
      author: c.author_name || "unknown",
    })));
    if (batch.length < 100) break;
    page++;
  }
  return allCommits;
}

const [projectId, fromTag, toTag, frontendProjectId, since] = process.argv.slice(2);

if (!projectId || !fromTag || !toTag) {
  console.error("Usage: node scripts/customer-summary.js <projectId> <fromTag> <toTag> [frontendProjectId] [since]");
  process.exit(1);
}

// Backend commits (tag range)
console.error(`Fetching backend commits: ${fromTag} → ${toTag} ...`);
const backendCommits = await getCommitsBetweenTags(projectId, fromTag, toTag);
console.error(`Found ${backendCommits.length} backend commits`);

const backendMRs = await getMergeRequestsForCommits(projectId, backendCommits.map(c => c.sha));
console.error(`Found ${backendMRs.length} backend MRs`);

// Frontend commits (date range, separate repo)
let frontendCommits = [], frontendMRs = [];
if (frontendProjectId && since) {
  console.error(`\nFetching frontend commits since ${since} ...`);
  frontendCommits = await getCommitsSince(frontendProjectId, since);
  console.error(`Found ${frontendCommits.length} frontend commits`);
  frontendMRs = await getMergeRequestsForCommits(frontendProjectId, frontendCommits.map(c => c.sha));
  console.error(`Found ${frontendMRs.length} frontend MRs`);
}

const commits = [...backendCommits, ...frontendCommits];
const mergeRequests = [...backendMRs, ...frontendMRs];
console.error(`\nTotal: ${commits.length} commits, ${mergeRequests.length} MRs\n`);

const client = new Anthropic();

const systemPrompt = `You are Louisa, a technical writer at Arthur preparing a customer-facing summary of recent Arthur Platform updates.

Your goal is to write a concise, compelling summary that a customer success manager can use to open a conversation with a customer about what's new — driving excitement and demonstrating value.

## Format

Write 4-6 bullet points. Each bullet should:
- Lead with the capability or user benefit (bold the feature name)
- Follow with 1-2 sentences explaining what it is and why it matters to the customer
- Be written for a non-technical business stakeholder, not an engineer
- Avoid internal jargon, MR numbers, commit SHAs, or implementation details

End with a single sentence framing the overall direction / momentum (no heading, just a closing line).

## Priorities

The following themes are confirmed top-of-mind — make sure these are prominently covered if there is evidence of them in the data:
1. New applications experience
2. New analytics experience (workspace and project level dashboards)
3. Early preview of discovery functionality

Any other meaningful user-facing improvements should be included if they're well-supported by the MR data.

## Tone
- Confident and forward-looking
- Customer-centric ("you can now...", "your team can...")
- No fluff or filler. Every sentence should earn its place.

## Output rules
- Raw text, no markdown headings
- Use bullet points (-)
- Do NOT include a title or intro line — start directly with the first bullet`;

const userContent = `Arthur Platform changes: ${fromTag} → ${toTag}

Commits (${commits.length} total):
${commits.map(c => `- ${c.sha} ${c.message} (${c.author})`).join("\n")}

Merged MRs (${mergeRequests.length} total):
${mergeRequests.length === 0
  ? "No linked MRs found."
  : mergeRequests.map(mr =>
      `MR !${mr.number}: ${mr.title}\nAuthor: ${mr.author} | Labels: ${mr.labels.join(", ") || "none"}\n${mr.body ? "Description:\n" + mr.body : "(no description)"}`
    ).join("\n\n")
}

Please write the customer summary now.`;

const message = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  system: systemPrompt,
  messages: [{ role: "user", content: userContent }],
});

const text = message.content
  .filter(b => b.type === "text")
  .map(b => b.text)
  .join("\n");

console.log("\n" + "─".repeat(60));
console.log(text.trim());
console.log("─".repeat(60) + "\n");
