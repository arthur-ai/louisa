#!/usr/bin/env node
// Lists all production platform tags from GitLab, optionally filtered by a since date.
// Usage: node scripts/list-prod-tags.js [since-date]  e.g. 2026-01-31

const GITLAB_API = "https://gitlab.com/api/v4";
const projectId  = process.env.GITLAB_PROJECT_ID;
const token      = process.env.GITLAB_TOKEN;
const since      = process.argv[2] ? new Date(process.argv[2]) : null;

const allTags = [];
let page = 1;

while (true) {
  const url = `${GITLAB_API}/projects/${projectId}/repository/tags?per_page=100&page=${page}&order_by=updated&sort=desc`;
  const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  if (!res.ok) { console.error("Error:", res.status, await res.text()); break; }
  const batch = await res.json();
  if (!batch.length) break;
  allTags.push(...batch);
  page++;
  if (batch.length < 100) break;
}

const prod = allTags
  .filter(t => t.name.endsWith("-success-aws-prod-platform"))
  .map(t => ({ name: t.name, date: new Date(t.commit?.created_at || t.created_at) }))
  .sort((a, b) => b.date - a.date);

const filtered = since ? prod.filter(t => t.date >= since) : prod;

console.log(`Found ${filtered.length} production tags${since ? ` since ${since.toISOString().slice(0,10)}` : ""}:\n`);
filtered.forEach(t => console.log(t.date.toISOString().slice(0,10), t.name));
