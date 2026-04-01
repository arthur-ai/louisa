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
        c.user?.type !== "Bot"
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

/**
 * Fetch the commit date for a tag via the Git refs API.
 * Works for both lightweight tags (object.type === "commit") and annotated tags
 * (object.type === "tag", which requires a second call to dereference to the commit).
 * Returns an ISO date string, or null on failure.
 */
async function getTagCommitDate(owner, repo, tag) {
  const refRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
    { headers: headers() }
  );
  if (!refRes.ok) return null;
  const ref = await refRes.json();

  // Lightweight tag: object points directly to a commit
  if (ref.object?.type === "commit") {
    const commitRes = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${ref.object.sha}`,
      { headers: headers() }
    );
    if (!commitRes.ok) return null;
    const commit = await commitRes.json();
    return commit.author?.date || commit.committer?.date || null;
  }

  // Annotated tag: object points to a tag object — dereference it
  const tagRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/tags/${ref.object.sha}`,
    { headers: headers() }
  );
  if (!tagRes.ok) return null;
  const tagObj = await tagRes.json();
  if (!tagObj.object?.sha) return null;

  // Tag object points to a commit
  const commitRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${tagObj.object.sha}`,
    { headers: headers() }
  );
  if (!commitRes.ok) return null;
  const commit = await commitRes.json();
  return commit.author?.date || commit.committer?.date || null;
}

/**
 * Returns the tag immediately before currentTag in commit-date order, filtering
 * out draft, prerelease, and sdk- tags.
 *
 * Uses the Tags API (via getTagCommitDate) rather than the Releases API so that
 * out-of-order or backdated releases don't corrupt the sort. published_at on a
 * GitHub release is set when the release is created — not when the tag was made —
 * so it is an unreliable sort key.
 */
export async function getPreviousReleaseTag(owner, repo, currentTag) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=50`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return null;

  const releases = await res.json();
  const candidates = releases.filter(
    (r) => !r.draft && !r.prerelease && !r.tag_name.startsWith("sdk-")
  );

  // Fetch commit dates for all candidates + currentTag in parallel
  const allTags = [...new Set([currentTag, ...candidates.map((r) => r.tag_name)])];
  const dateEntries = await Promise.all(
    allTags.map(async (tag) => [tag, await getTagCommitDate(owner, repo, tag)])
  );
  const dateMap = Object.fromEntries(dateEntries);

  if (!dateMap[currentTag]) {
    console.warn(`Louisa: could not find commit date for tag ${currentTag} — falling back to recent commits`);
    return null;
  }

  // Sort by commit date descending, exclude tags with no date
  const sorted = candidates
    .filter((r) => dateMap[r.tag_name])
    .sort((a, b) => new Date(dateMap[b.tag_name]) - new Date(dateMap[a.tag_name]));

  const idx = sorted.findIndex((r) => r.tag_name === currentTag);
  if (idx >= 0 && idx < sorted.length - 1) {
    return sorted[idx + 1].tag_name;
  }

  if (idx === -1) {
    console.warn(`Louisa: ${currentTag} not found in sorted releases — falling back to recent commits`);
    return null;
  }

  return null;
}

/**
 * Fetch the commit date for a tag (exported for use by the webhook to determine
 * the date range for getPRsByDateRange).
 */
export async function getTagDate(owner, repo, tag) {
  return getTagCommitDate(owner, repo, tag);
}

/**
 * Fetch PRs merged between fromDate and toDate using the GitHub Search API.
 *
 * Uses merged: date qualifier rather than updated: so that Louisa's own post-merge
 * enrichment (which updates updated_at) does not pull PRs from prior releases into
 * future release note windows.
 *
 * Known limitation: GitHub Search API has a ~1-minute indexing lag. PRs merged in
 * the ~2 minutes between tag creation and webhook firing may be missed. This is
 * acceptable — the window is narrow and such PRs appear in the next release.
 *
 * toDate should be set to currentTagDate + 10 minutes to capture PRs merged during
 * the CI run (between tag creation and webhook delivery).
 */
export async function getPRsByDateRange(owner, repo, fromDate, toDate) {
  const prs = new Map();
  let page = 1;

  while (true) {
    // GitHub Search supports ISO 8601 datetime in merged: qualifier (YYYY-MM-DDTHH:MM:SSZ).
    // Strip milliseconds (.000Z → Z) to match the supported format exactly.
    const from = fromDate.replace(/\.\d{3}Z$/, "Z");
    const to   = toDate.replace(/\.\d{3}Z$/, "Z");
    const q    = `is:pr is:merged repo:${owner}/${repo} merged:${from}..${to}`;
    const url  = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;

    const res = await fetch(url, { headers: headers() });

    if (res.status === 429) {
      // Search API rate limit: 30 req/min authenticated. Back off and retry once.
      console.warn("Louisa: GitHub Search API rate limited, waiting 10s before retry");
      await new Promise((r) => setTimeout(r, 10_000));
      const retry = await fetch(url, { headers: headers() });
      if (!retry.ok) {
        console.error(`Louisa: GitHub Search API retry failed (${retry.status}), returning partial results`);
        break;
      }
      const data = await retry.json();
      for (const item of data.items || []) {
        if (!prs.has(item.number)) {
          prs.set(item.number, formatSearchPR(item));
        }
      }
      if ((data.items || []).length < 100) break;
      page++;
      continue;
    }

    if (!res.ok) {
      // Fail open: return whatever we have so release notes still generate from commits
      console.error(`Louisa: GitHub Search API error (${res.status}), returning partial results`);
      break;
    }

    const data = await res.json();
    for (const item of data.items || []) {
      if (!prs.has(item.number)) {
        prs.set(item.number, formatSearchPR(item));
      }
    }
    if ((data.items || []).length < 100) break;
    page++;
  }

  return [...prs.values()];
}

function formatSearchPR(item) {
  return {
    number: item.number,
    title: item.title,
    body: (item.body || "").slice(0, 3000),
    author: item.user?.login,
    labels: (item.labels || []).map((l) => l.name),
    url: item.html_url,
  };
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
