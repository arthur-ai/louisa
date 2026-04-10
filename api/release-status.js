/**
 * Vercel cron function — runs every 4 minutes.
 * Polls GitHub Actions for in-progress generate-release.yml runs and logs
 * their status to Vercel so it's visible in the Vercel dashboard logs.
 *
 * Required env vars:
 *   LOUISA_GITHUB_REPO  — "owner/repo" of this repo, e.g. "arthur-ai/louisa"
 *   GITHUB_TOKEN        — PAT with actions:read permission
 */

export const config = { maxDuration: 15 };

const WORKFLOW_FILE = "generate-release.yml";

export default async function handler(req, res) {
  const repo  = process.env.LOUISA_GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;

  if (!repo || !token) {
    console.warn("Louisa release-status: LOUISA_GITHUB_REPO or GITHUB_TOKEN not set — skipping");
    return res.status(200).json({ skipped: true });
  }

  const [owner, repoName] = repo.split("/");

  // Fetch in-progress runs for the generate-release workflow
  const url = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${WORKFLOW_FILE}/runs` +
              `?status=in_progress&per_page=10`;

  const ghRes = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        "application/vnd.github.v3+json",
    },
  });

  if (!ghRes.ok) {
    console.error(`Louisa release-status: GitHub Actions API error ${ghRes.status}`);
    return res.status(200).json({ error: ghRes.status });
  }

  const { workflow_runs: runs, total_count } = await ghRes.json();

  if (!runs?.length) {
    console.log("Louisa release-status: no release generation jobs currently running");
    return res.status(200).json({ running: 0 });
  }

  for (const run of runs) {
    const tag     = run.display_title || run.name || "(unknown tag)";
    const elapsed = Math.round((Date.now() - new Date(run.created_at).getTime()) / 1000 / 60);
    const url     = run.html_url;
    console.log(`Louisa release-status: IN PROGRESS — ${tag} | elapsed ${elapsed}m | ${url}`);
  }

  return res.status(200).json({ running: runs.length, total_count });
}
