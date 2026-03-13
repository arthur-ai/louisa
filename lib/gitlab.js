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
            body: (mr.description || "").slice(0, 1000),
            author: mr.author?.username,
            labels: mr.labels || [],
            url: mr.web_url,
          });
        }
      }
    }
  }

  return [...mrs.values()];
}

/**
 * Get the previous release tag from GitLab.
 */
export async function getPreviousReleaseTag(projectId, currentTag) {
  const url = `${GITLAB_API}/projects/${projectId}/releases?order_by=released_at&sort=desc&per_page=50`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return null;

  const releases = await res.json();
  // Only consider production platform releases so dev/staging tags don't pollute the diff range
  const prodReleases = releases.filter((r) => r.tag_name.endsWith("-success-aws-prod-platform"));

  const idx = prodReleases.findIndex((r) => r.tag_name === currentTag);
  if (idx >= 0 && idx < prodReleases.length - 1) {
    return prodReleases[idx + 1].tag_name;
  }

  if (idx === -1 && prodReleases.length > 0) {
    return prodReleases[0].tag_name;
  }

  return null;
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
