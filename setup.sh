#!/usr/bin/env bash
set -euo pipefail

echo "🤖 Louisa — Setting up project files..."

# ── Create directories ──
mkdir -p api lib

# ── package.json ──
cat > package.json << 'ENDOFFILE'
{
  "name": "louisa",
  "version": "1.0.0",
  "description": "Automatic release notes bot for Arthur Evals Engine",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vercel dev",
    "deploy": "vercel deploy --prod"
  },
  "dependencies": {},
  "devDependencies": {
    "vercel": "^39.0.0"
  }
}
ENDOFFILE
echo "  ✔ package.json"

# ── vercel.json ──
cat > vercel.json << 'ENDOFFILE'
{
  "functions": {
    "api/webhook.js": {
      "maxDuration": 60
    }
  }
}
ENDOFFILE
echo "  ✔ vercel.json"

# ── .gitignore ──
cat > .gitignore << 'ENDOFFILE'
node_modules/
.env.local
.vercel/
ENDOFFILE
echo "  ✔ .gitignore"

# ── .env.local (template) ──
cat > .env.local << 'ENDOFFILE'
GITHUB_TOKEN=ghp_REPLACE_ME
GITHUB_WEBHOOK_SECRET=REPLACE_ME
ANTHROPIC_API_KEY=sk-ant-REPLACE_ME
GITHUB_REPO_OWNER=arthur-ai
GITHUB_REPO_NAME=evals-engine
ENDOFFILE
echo "  ✔ .env.local (template — fill in your real values)"

# ── lib/crypto.js ──
cat > lib/crypto.js << 'ENDOFFILE'
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the GitHub webhook signature (HMAC-SHA256).
 * Returns true if the payload signature matches our secret.
 */
export function verifyGitHubSignature(payload, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const expected = "sha256=" +
    createHmac("sha256", secret).update(payload).digest("hex");

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
ENDOFFILE
echo "  ✔ lib/crypto.js"

# ── lib/github.js ──
cat > lib/github.js << 'ENDOFFILE'
const GITHUB_API = "https://api.github.com";

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Fetch commits between two tags (previous release → this release).
 * If no previous tag exists, fetches the last 50 commits up to `toTag`.
 */
export async function getCommitsBetweenTags(owner, repo, fromTag, toTag) {
  if (fromTag) {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/compare/${fromTag}...${toTag}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      console.error("Compare API error:", res.status, await res.text());
      return [];
    }
    const data = await res.json();
    return (data.commits || []).map(formatCommit);
  }

  // No previous tag — grab recent commits on the tag's branch
  const url = `${GITHUB_API}/repos/${owner}/${repo}/commits?sha=${toTag}&per_page=50`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return [];
  const data = await res.json();
  return data.map(formatCommit);
}

/**
 * Fetch merged pull requests associated with a list of commit SHAs.
 */
export async function getPullRequestsForCommits(owner, repo, commitShas) {
  const prs = new Map();

  const batches = [];
  for (let i = 0; i < commitShas.length; i += 10) {
    batches.push(commitShas.slice(i, i + 10));
  }

  for (const batch of batches) {
    const results = await Promise.all(
      batch.map(async (sha) => {
        const url = `${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}/pulls`;
        const res = await fetch(url, { headers: headers() });
        if (!res.ok) return [];
        return res.json();
      })
    );

    for (const prList of results) {
      for (const pr of prList) {
        if (pr.merged_at && !prs.has(pr.number)) {
          prs.set(pr.number, {
            number: pr.number,
            title: pr.title,
            body: (pr.body || "").slice(0, 1000),
            author: pr.user?.login,
            labels: (pr.labels || []).map((l) => l.name),
            url: pr.html_url,
          });
        }
      }
    }
  }

  return [...prs.values()];
}

/**
 * Get the tag name of the release published immediately before the given one.
 */
export async function getPreviousReleaseTag(owner, repo, currentTag) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=10`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return null;

  const releases = await res.json();
  const published = releases
    .filter((r) => !r.draft && !r.prerelease)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  const idx = published.findIndex((r) => r.tag_name === currentTag);
  if (idx >= 0 && idx < published.length - 1) {
    return published[idx + 1].tag_name;
  }
  return null;
}

/**
 * Update the body of an existing GitHub release.
 */
export async function updateReleaseBody(owner, repo, releaseId, body) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/${releaseId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update release ${releaseId}: ${res.status} — ${err}`);
  }
  return res.json();
}

function formatCommit(c) {
  return {
    sha: c.sha?.slice(0, 8),
    message: (c.commit?.message || c.message || "").split("\n")[0],
    author: c.author?.login || c.commit?.author?.name || "unknown",
  };
}
ENDOFFILE
echo "  ✔ lib/github.js"

# ── lib/claude.js ──
cat > lib/claude.js << 'ENDOFFILE'
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
ENDOFFILE
echo "  ✔ lib/claude.js"

# ── api/webhook.js ──
cat > api/webhook.js << 'ENDOFFILE'
import { verifyGitHubSignature } from "../lib/crypto.js";
import {
  getCommitsBetweenTags,
  getPullRequestsForCommits,
  getPreviousReleaseTag,
  updateReleaseBody,
} from "../lib/github.js";
import { generateReleaseNotes } from "../lib/claude.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = typeof req.body === "string"
    ? req.body
    : JSON.stringify(req.body);

  const sig = req.headers["x-hub-signature-256"];
  if (!verifyGitHubSignature(rawBody, sig, process.env.GITHUB_WEBHOOK_SECRET)) {
    console.warn("Louisa: invalid webhook signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.headers["x-github-event"];
  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  if (event !== "release" || payload.action !== "published") {
    return res.status(200).json({ skipped: true, reason: `event=${event}, action=${payload.action}` });
  }

  const release = payload.release;
  if (release.draft || release.prerelease) {
    return res.status(200).json({ skipped: true, reason: "draft or prerelease" });
  }

  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  const tag = release.tag_name;
  const releaseId = release.id;

  console.log(`Louisa: processing release ${tag} (id=${releaseId})`);

  try {
    const previousTag = await getPreviousReleaseTag(owner, repo, tag);
    console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

    const commits = await getCommitsBetweenTags(owner, repo, previousTag, tag);
    console.log(`Louisa: found ${commits.length} commits`);

    const shas = commits.map((c) => c.sha);
    const pullRequests = await getPullRequestsForCommits(owner, repo, shas);
    console.log(`Louisa: found ${pullRequests.length} merged PRs`);

    const notes = await generateReleaseNotes({
      tagName: tag,
      releaseName: release.name,
      commits,
      pullRequests,
      previousTag,
    });

    const header = `# ${release.name || tag}\n\n`;
    const footer = `\n\n---\n_Release notes generated by Louisa 🤖_`;
    const fullBody = header + notes + footer;

    await updateReleaseBody(owner, repo, releaseId, fullBody);
    console.log(`Louisa: release ${tag} updated successfully`);

    return res.status(200).json({ ok: true, tag, notesLength: notes.length });
  } catch (err) {
    console.error("Louisa: error processing release", err);
    return res.status(500).json({ error: err.message });
  }
}
ENDOFFILE
echo "  ✔ api/webhook.js"

echo ""
echo "🎉 Louisa project files created successfully!"
echo ""
echo "Next steps:"
echo "  1. Edit .env.local and fill in your real credentials"
echo "  2. npm install"
echo "  3. vercel link && vercel deploy --prod"
echo "  4. Create the GitHub webhook pointing to your Vercel URL"
