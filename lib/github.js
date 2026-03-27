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
            // Increased limit to capture full enriched descriptions written by Louisa
            body: (pr.body || "").slice(0, 3000),
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

// ── PR enrichment helpers ──────────────────────────────────────────────────────

/**
 * Fetch the commits on a specific PR (up to 100).
 */
export async function getPRCommits(owner, repo, prNumber) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    console.error(`getPRCommits error: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.map((c) => ({
    sha: c.sha?.slice(0, 8),
    message: (c.commit?.message || "").split("\n")[0],
    author: c.author?.login || c.commit?.author?.name || "unknown",
  }));
}

/**
 * Fetch the files changed in a specific PR (up to 100).
 */
export async function getPRFiles(owner, repo, prNumber) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    console.error(`getPRFiles error: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
  }));
}

/**
 * Fetch meaningful human comments from a PR — both issue-level and review-level.
 * Filters out bot accounts and trivially short comments.
 */
export async function getPRComments(owner, repo, prNumber) {
  const [issueRes, reviewRes] = await Promise.all([
    fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=50`, {
      headers: headers(),
    }),
    fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=50`, {
      headers: headers(),
    }),
  ]);

  const issueComments  = issueRes.ok  ? await issueRes.json()  : [];
  const reviewComments = reviewRes.ok ? await reviewRes.json() : [];

  return [...issueComments, ...reviewComments]
    .filter(
      (c) =>
        c.body &&
        c.body.trim().length > 20 &&
        !c.user?.login?.includes("[bot]") &&
        !c.user?.type === "Bot"
    )
    .map((c) => c.body.trim().slice(0, 500));
}

/**
 * Update the title and body of an open or merged PR.
 */
export async function updatePR(owner, repo, prNumber, title, body) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`;
  console.log(`Louisa: updating PR #${prNumber} in ${owner}/${repo}`);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update PR #${prNumber}: ${res.status} — ${err}`);
  }
  return res.json();
}

export async function getPreviousReleaseTag(owner, repo, currentTag) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=50`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return null;

  const releases = await res.json();
  const published = releases
    .filter((r) => !r.draft && !r.prerelease && !r.tag_name.startsWith("sdk-"))
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  const idx = published.findIndex((r) => r.tag_name === currentTag);
  if (idx >= 0 && idx < published.length - 1) {
    return published[idx + 1].tag_name;
  }

  if (idx === -1 && published.length > 0) {
    return published[0].tag_name;
  }

  return null;
}

export async function getReleaseByTag(owner, repo, tag) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${tag}`;
  const res = await fetch(url, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error("getReleaseByTag error:", res.status, await res.text());
    return null;
  }
  return res.json();
}

export async function createRelease(owner, repo, tag, name, body) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases`;
  console.log(`Louisa: creating release for tag ${tag}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      name: name,
      body: body,
      draft: false,
      prerelease: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create release for ${tag}: ${res.status} — ${err}`);
  }
  return res.json();
}

export async function updateReleaseBody(owner, repo, releaseId, body) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/${releaseId}`;
  console.log(`Louisa: updating release ${releaseId}`);
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
