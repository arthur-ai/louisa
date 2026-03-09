const GITHUB_API = "https://api.github.com";

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

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

  const url = `${GITHUB_API}/repos/${owner}/${repo}/commits?sha=${toTag}&per_page=50`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return [];
  const data = await res.json();
  return data.map(formatCommit);
}

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

export async function updateReleaseBody(owner, repo, releaseId, body) {
  const token = process.env.GITHUB_TOKEN;
  console.log(`Louisa DEBUG: token present = ${!!token}, starts with = ${token ? token.slice(0, 10) : "NONE"}`);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/${releaseId}`;
  console.log(`Louisa DEBUG: PATCH ${url}`);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });

  console.log(`Louisa DEBUG: response status = ${res.status}`);

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