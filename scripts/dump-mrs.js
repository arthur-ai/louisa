#!/usr/bin/env node
// Dumps all MR titles+descriptions between two tags to help debug what's included
import { getCommitsBetweenTags, getMergeRequestsForCommits } from "../lib/gitlab.js";

const [projectId, fromTag, toTag] = process.argv.slice(2);
const commits = await getCommitsBetweenTags(projectId, fromTag, toTag);
const shas = commits.map(c => c.sha);
const mrs = await getMergeRequestsForCommits(projectId, shas);

mrs.sort((a, b) => a.number - b.number);
mrs.forEach(mr => {
  console.log(`!${mr.number}: ${mr.title}`);
  if (mr.body) console.log(`  ${mr.body.slice(0, 200).replace(/\n/g, ' ')}`);
});
console.error(`\nTotal: ${mrs.length} MRs from ${commits.length} commits`);
