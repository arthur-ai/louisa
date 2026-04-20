/**
 * Vercel cron function — runs every 4 minutes.
 * Polls GitHub Actions for in-progress release runs and logs
 * their status to Vercel so it's visible in the Vercel dashboard logs.
 *
 * Required env vars:
 *   LOUISA_GITHUB_REPO          — "owner/repo" of this repo, e.g. "arthur-ai/louisa"
 *   GITHUB_APP_ID               — GitHub App ID
 *   GITHUB_APP_PRIVATE_KEY      — GitHub App private key (PEM)
 *   GITHUB_APP_INSTALLATION_ID  — GitHub App installation ID
 */

import { getInstallationToken } from "../lib/github-app.js";

export const config = { maxDuration: 15 };

const WORKFLOW_FILES = ["generate-release.yml", "generate-github-release.yml"];

export default async function handler(req, res) {
  const repo = process.env.LOUISA_GITHUB_REPO;

  if (!repo) {
    console.warn("Louisa release-status: LOUISA_GITHUB_REPO not set — skipping");
    return res.status(200).json({ skipped: true });
  }

  let token;
  try {
    token = await getInstallationToken();
  } catch (err) {
    console.warn(`Louisa release-status: could not get App token — ${err.message}`);
    return res.status(200).json({ skipped: true });
  }

  const [owner, repoName] = repo.split("/");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" };

  let totalRunning = 0;
  for (const workflow of WORKFLOW_FILES) {
    const url   = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${workflow}/runs?status=in_progress&per_page=10`;
    const ghRes = await fetch(url, { headers });

    if (!ghRes.ok) {
      console.error(`Louisa release-status: ${workflow} API error ${ghRes.status}`);
      continue;
    }

    const { workflow_runs: runs } = await ghRes.json();
    if (!runs?.length) continue;

    for (const run of runs) {
      const tag     = run.display_title || run.name || "(unknown tag)";
      const elapsed = Math.round((Date.now() - new Date(run.created_at).getTime()) / 1000 / 60);
      console.log(`Louisa release-status: IN PROGRESS — ${workflow} | ${tag} | elapsed ${elapsed}m | ${run.html_url}`);
      totalRunning++;
    }
  }

  if (totalRunning === 0) {
    console.log("Louisa release-status: no release generation jobs currently running");
  }

  return res.status(200).json({ running: totalRunning });
}
