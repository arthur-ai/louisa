const GITLAB_API = "https://gitlab.com/api/v4";

function headers() {
  return {
    "PRIVATE-TOKEN": process.env.GITLAB_TOKEN,
    "Content-Type": "application/json",
  };
}

/**
 * Fetch commits between two tags using the compare API.
 * If no fromTag, fetches the last 50 commits on the toTag.
 */
export async function getCommitsBetweenTags(projectId, fromTag, toTag) {
  if (fromTag) {
    const url = `${GITLAB_API}/projects/${projectId}/repository/compare?from=${encodeURIComponent(fromTag)}&to=${encodeURIComponent(toTag)}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      console.error("GitLab Compare API error:", res.status, await res.text());
      return [];
    }
    const data = await res.json();
    return (data.commits || []).map(formatCommit);
  }

  const url = `${GITLAB_API}/projects/${projectId}/repository/commits?ref_name=${encodeURIComponent(toTag)}&per_page=50`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return [];
  const data = await res.json();
  return data.map(formatCommit);
}

/**
 * Fetch commits by date range on the default branch.
 * Used for scope (frontend) project where backend tag names don't exist.
 */
export async function getCommitsBetweenDates(projectId, since, until) {
  const url = `${GITLAB_API}/projects/${projectId}/repository/commits?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=100`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    console.error("GitLab Commits by date API error:", res.status, await res.text());
    return [];
  }
  const data = await res.json();
  return data.map(formatCommit);
}

/**
 * Fetch merged merge requests between two dates or associated with commits.
 */
export async function getMergeRequestsForCommits(projectId, commitShas) {
  const mrs = new Map();

  const batches = [];
  for (let i = 0; i < commitShas.length; i += 10) {
    batches.push(commitShas.slice(i, i + 10));
  }

  for (const batch of batches) {
    const results = await Promise.all(
      batch.map(async (sha) => {
        const url = `${GITLAB_API}/projects/${projectId}/repository/commits/${sha}/merge_requests`;
        const res = await fetch(url, { headers: headers() });
        if (!res.ok) return [];
        return res.json();
      })
    );

    for (const mrList of results) {
      for (const mr of mrList) {
        if (mr.state === "merged" && !mrs.has(mr.iid)) {
          mrs.set(mr.iid, {
            number: mr.iid,
            title: mr.title,
            // Increased limit to capture full enriched descriptions written by Louisa
            body: (mr.description || "").slice(0, 3000),
            author: mr.author?.username,
            labels: mr.labels || [],
            url: mr.web_url,
            mergedAt: mr.merged_at || null,
          });
        }
      }
    }
  }

  return [...mrs.values()];
}

// ── Per-MR read helpers (used at merge time to generate the summaries log) ─────

/**
 * Fetch the commits on a specific MR (up to 100).
 */
export async function getMRCommits(projectId, mrIid) {
  const url = `${GITLAB_API}/projects/${projectId}/merge_requests/${mrIid}/commits?per_page=100`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    console.error(`getMRCommits error: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.map((c) => ({
    sha: (c.id || c.short_id || "").slice(0, 8),
    message: (c.title || c.message || "").split("\n")[0],
    author: c.author_name || "unknown",
  }));
}

/**
 * Fetch the files changed in a specific MR (up to 100).
 * Uses the /diffs endpoint (GitLab ≥ 14.7).
 */
export async function getMRChanges(projectId, mrIid) {
  const url = `${GITLAB_API}/projects/${projectId}/merge_requests/${mrIid}/diffs?per_page=100`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    console.error(`getMRChanges error: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.map((f) => ({
    filename: f.new_path || f.old_path,
    status: f.deleted_file ? "removed" : f.new_file ? "added" : f.renamed_file ? "renamed" : "modified",
    additions: (f.diff?.match(/^\+[^+]/gm) || []).length,
    deletions: (f.diff?.match(/^-[^-]/gm) || []).length,
  }));
}

/**
 * Fetch meaningful human notes / comments from an MR.
 * Filters out system notes (state changes, approvals, etc.) and trivially short bodies.
 */
export async function getMRNotes(projectId, mrIid) {
  const url = `${GITLAB_API}/projects/${projectId}/merge_requests/${mrIid}/notes?per_page=50&sort=asc`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    console.error(`getMRNotes error: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data
    .filter((n) => !n.system && n.body && n.body.trim().length > 20 && !n.author?.bot)
    .map((n) => n.body.trim().slice(0, 500));
}

/**
 * Returns the tag immediately before currentTag in commit-date order, considering
 * only tags matching GITLAB_PROD_TAG_SUFFIX (default: -success-aws-prod-platform).
 *
 * Uses the Tags API paginated by updated date rather than the Releases API, mirroring
 * scripts/list-prod-tags.js. released_at on GitLab releases is backdatable and set at
 * release creation time — not tag creation time — so it is an unreliable sort key.
 *
 * Pagination is capped at 10 pages (1000 tags) to avoid hitting Vercel's 60s limit.
 */
export async function getPreviousReleaseTag(projectId, currentTag) {
  const rawSuffix = process.env.GITLAB_PROD_TAG_SUFFIX;
  if (rawSuffix === "") {
    console.warn("Louisa: GITLAB_PROD_TAG_SUFFIX is empty string — defaulting to -success-aws-prod-platform");
  }
  const effectiveSuffix = rawSuffix || "-success-aws-prod-platform";

  // Fetch all tags paginated, cap at 10 pages to stay within Vercel 60s limit
  const allTags = [];
  const PAGE_CAP = 10;
  for (let page = 1; page <= PAGE_CAP; page++) {
    const url = `${GITLAB_API}/projects/${projectId}/repository/tags?order_by=updated&sort=desc&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      // A failure on the very first page means we fetched zero tags. This is almost
      // always an auth/access problem rather than an empty repo: GitLab returns 404
      // (not 401/403) for repository endpoints when the token is revoked or lacks
      // access to the project — e.g. a personal access token whose owner's account
      // was deactivated. Throw a clear error instead of silently returning "no
      // previous tag", which produced a confusing null-destructure TypeError downstream.
      if (page === 1) {
        throw new Error(
          `GitLab Tags API returned ${res.status} for project ${projectId} on page 1. ` +
          `The GITLAB_TOKEN is likely revoked or lacks access to this project ` +
          `(GitLab returns 404 for repository endpoints when auth fails). ` +
          `Rotate GITLAB_TOKEN to an active service-account or project/group access token.`
        );
      }
      console.error(`Louisa: GitLab Tags API error on page ${page}: ${res.status}`);
      break;
    }
    const batch = await res.json();
    allTags.push(...batch);
    if (batch.length < 100) break;
    if (page === PAGE_CAP) {
      console.warn(`Louisa: GitLab tag pagination capped at ${PAGE_CAP} pages — results may be incomplete`);
    }
  }

  // Filter to prod tags and sort by commit creation date descending
  const prodTags = allTags
    .filter((t) => t.name.endsWith(effectiveSuffix))
    .sort((a, b) => {
      const da = new Date(a.commit?.created_at || a.created_at || 0);
      const db = new Date(b.commit?.created_at || b.created_at || 0);
      return db - da;
    });

  if (prodTags.length === 0) {
    console.warn(`Louisa: no tags found matching suffix "${effectiveSuffix}" in project ${projectId}`);
    // Return the same shape as every other branch so callers can safely destructure;
    // a null fromDate/toDate makes the pipeline fall back to recent-commits mode.
    return { name: null, fromDate: null, toDate: null };
  }

  const idx = prodTags.findIndex((t) => t.name === currentTag);

  const toDate = idx >= 0
    ? (prodTags[idx].commit?.created_at || prodTags[idx].created_at || null)
    : null;

  if (idx >= 0 && idx < prodTags.length - 1) {
    const prev = prodTags[idx + 1];
    return {
      name:     prev.name,
      fromDate: prev.commit?.created_at || prev.created_at || null,
      toDate,
    };
  }

  if (idx === -1) {
    console.warn(`Louisa: ${currentTag} not found in prod tags — falling back to recent commits`);
  }

  return { name: null, fromDate: null, toDate };
}

/**
 * Returns the commit date of a tag, or null if not found.
 * Used to set the date range for getMRsByDateRange.
 */
export async function getTagDate(projectId, tag) {
  const url = `${GITLAB_API}/projects/${projectId}/repository/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return null;
  const data = await res.json();
  return data.commit?.created_at || data.created_at || null;
}

/**
 * Fetch MRs merged between fromDate and toDate using merged_after / merged_before.
 *
 * Uses merged_at rather than updated_at to avoid pulling MRs from prior releases
 * into future release note windows.
 *
 * toDate should be set to currentTagDate + 10 minutes to capture MRs merged during
 * the CI run (between tag creation and webhook delivery).
 */
export async function getMRsByDateRange(projectId, fromDate, toDate) {
  const mrs = new Map();
  const base = `${GITLAB_API}/projects/${projectId}/merge_requests?state=merged` +
    `&merged_after=${encodeURIComponent(fromDate)}` +
    `&merged_before=${encodeURIComponent(toDate)}` +
    `&per_page=100`;

  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${base}&page=${page}`, { headers: headers() });
    if (!res.ok) {
      console.error(`Louisa: GitLab MR date-range API error (${res.status}), returning partial`);
      break;
    }
    const data = await res.json();
    for (const mr of data) {
      if (!mrs.has(mr.iid)) {
        mrs.set(mr.iid, {
          number: mr.iid,
          title: mr.title,
          body: (mr.description || "").slice(0, 3000),
          author: mr.author?.username,
          labels: mr.labels || [],
          url: mr.web_url,
          mergedAt: mr.merged_at || null,
        });
      }
    }
    if (data.length < 100) break;
    if (page === 10) {
      console.warn(`Louisa: GitLab MR date-range pagination capped at 10 pages — results may be incomplete`);
    }
  }

  return [...mrs.values()];
}

/**
 * Check if a release already exists for a given tag.
 */
export async function getReleaseByTag(projectId, tag) {
  const url = `${GITLAB_API}/projects/${projectId}/releases/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error("GitLab getReleaseByTag error:", res.status, await res.text());
    return null;
  }
  return res.json();
}

/**
 * Create a new release in GitLab.
 */
export async function createRelease(projectId, tag, name, description) {
  const url = `${GITLAB_API}/projects/${projectId}/releases`;
  console.log(`Louisa: creating GitLab release for tag ${tag}`);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      tag_name: tag,
      name: name,
      description: description,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create GitLab release for ${tag}: ${res.status} — ${err}`);
  }
  return res.json();
}

/**
 * Update an existing release in GitLab.
 */
export async function updateReleaseDescription(projectId, tag, description) {
  const url = `${GITLAB_API}/projects/${projectId}/releases/${encodeURIComponent(tag)}`;
  console.log(`Louisa: updating GitLab release ${tag}`);
  const res = await fetch(url, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ description }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update GitLab release ${tag}: ${res.status} — ${err}`);
  }
  return res.json();
}

/**
 * Get the project web URL for building release links.
 */
export async function getProjectUrl(projectId) {
  const url = `${GITLAB_API}/projects/${projectId}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return null;
  const data = await res.json();
  return data.web_url;
}

function formatCommit(c) {
  return {
    sha: (c.id || c.short_id || "").slice(0, 8),
    message: (c.title || c.message || "").split("\n")[0],
    author: c.author_name || "unknown",
  };
}
