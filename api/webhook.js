import { verifyGitHubSignature } from "../lib/crypto.js";
import {
  getCommitsBetweenTags,
  getPRsByDateRange,
  getTagDate,
  getPreviousReleaseTag,
  getReleaseByTag,
  createRelease,
  updateReleaseBody,
  getPRCommits,
  getPRFiles,
  getPRComments,
} from "../lib/github.js";
import { summarizePR, generateReleaseNotes } from "../lib/claude.js";
import { appendSummary, readSummariesInRange } from "../lib/summaries.js";
import { shouldSkipEnrichment } from "../lib/enrich.js";
import { postReleaseNotification } from "../lib/slack.js";
import { getTracer, forceFlush, activeSpan } from "../lib/otel.js";

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

  // Initialise the OTel provider (+ Anthropic auto-instrumentation) once per container.
  const tracer = getTracer();

  // ─── Tag push: generate and publish a new release ───────────────────────────
  if (event === "create" && payload.ref_type === "tag") {
    const tag   = payload.ref;
    const owner = payload.repository.owner.login;
    const repo  = payload.repository.name;

    console.log(`Louisa: new tag detected — ${tag}`);

    if (tag.includes("-dev") || tag.startsWith("sdk-")) {
      console.log(`Louisa: skipping non-primary tag ${tag}`);
      return res.status(200).json({ skipped: true, reason: "non-primary tag" });
    }

    try {
      const result = await activeSpan(tracer, "louisa.github.release", {
        "openinference.span.kind": "CHAIN",
        "agent.name":              "Louisa",
        "input.value":             JSON.stringify({ event: "tag_push", tag, repository: `${owner}/${repo}` }),
        "input.mime_type":         "application/json",
        "tag":                     tag,
        "repository":              `${owner}/${repo}`,
      }, async (rootSpan) => {

        const existing = await getReleaseByTag(owner, repo, tag);
        if (existing) {
          console.log(`Louisa: release already exists for ${tag}, skipping`);
          rootSpan.setAttribute("output.value",     "skipped: release already exists");
          rootSpan.setAttribute("output.mime_type", "text/plain");
          return { skipped: true, reason: "release already exists" };
        }

        const previousTag = await activeSpan(tracer, "github.get_previous_tag", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.getPreviousReleaseTag",
          "tool.description":        "Finds the most recent release tag before the given tag to determine the commit diff range",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", tag: "string" }),
          "input.value":             JSON.stringify({ owner, repo, tag }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const r = await getPreviousReleaseTag(owner, repo, tag);
          s.setAttribute("output.value",     r || "(none)");
          s.setAttribute("output.mime_type", "text/plain");
          return r;
        });
        console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

        const commits = await activeSpan(tracer, "github.get_commits", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.getCommitsBetweenTags",
          "tool.description":        "Retrieves all commits between two tags to identify what changed in this release",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", base: "string", head: "string" }),
          "input.value":             JSON.stringify({ owner, repo, base: previousTag, head: tag }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const r = await getCommitsBetweenTags(owner, repo, previousTag, tag);
          s.setAttribute("output.value",     JSON.stringify(r.map(c => ({ sha: c.sha.slice(0, 7), message: c.message }))));
          s.setAttribute("output.mime_type", "application/json");
          return r;
        });
        console.log(`Louisa: found ${commits.length} commits`);

        const [fromTagDate, toTagDate] = await Promise.all([
          previousTag ? getTagDate(owner, repo, previousTag) : Promise.resolve(null),
          getTagDate(owner, repo, tag),
        ]);
        const pullRequests = await activeSpan(tracer, "github.get_pull_requests", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.getPRsForRelease",
          "tool.description":        "Resolves merged PRs for the release window — reads pre-computed summaries from log if available, falls back to GitHub Search API",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", fromDate: "string", toDate: "string" }),
          "input.value":             JSON.stringify({ owner, repo, fromDate: fromTagDate, toDate: toTagDate }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          if (previousTag && !fromTagDate) {
            console.warn(`Louisa: could not resolve date for previous tag ${previousTag} — skipping PR fetch to avoid epoch-range query`);
            s.setAttribute("output.value",     "[]");
            s.setAttribute("output.mime_type", "application/json");
            return [];
          }
          const from = fromTagDate || new Date(0).toISOString();
          const to   = toTagDate
            ? new Date(new Date(toTagDate).getTime() + 10 * 60 * 1000).toISOString()
            : new Date().toISOString();

          // Try the local summaries log first — populated at PR merge time
          const cached = readSummariesInRange(`${owner}/${repo}`, from, to);
          if (cached !== null) {
            console.log(`Louisa: using ${cached.length} pre-computed PR summaries from log`);
            s.setAttribute("output.value",     JSON.stringify(cached.map(e => ({ number: e.number, title: e.title }))));
            s.setAttribute("output.mime_type", "application/json");
            return cached.map((entry) => ({
              number: entry.number,
              title:  entry.title,
              body:   `**Summary:** ${entry.summary}\n\n**User Impact:** ${entry.userImpact}\n\n**Type:** ${entry.type}`,
              author: entry.author,
              labels: entry.labels || [],
              url:    entry.url,
            }));
          }

          // Summaries log absent — fall back to live GitHub Search API
          console.log(`Louisa: summaries log not found, fetching PRs from GitHub API`);
          const r = await getPRsByDateRange(owner, repo, from, to);
          s.setAttribute("output.value",     JSON.stringify(r.map(pr => ({ number: pr.number, title: pr.title }))));
          s.setAttribute("output.mime_type", "application/json");
          return r;
        });
        console.log(`Louisa: found ${pullRequests.length} merged PRs`);

        // generateReleaseNotes() wraps messages.create() in an explicit LLM span
        // (louisa.llm.generate_release_notes) with full OpenInference attributes.
        const { text: notes } = await activeSpan(tracer, "louisa.generate_release_notes", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "louisa.generateReleaseNotes",
          "tool.description":        "Calls Claude to write polished release notes from commits and pull requests",
          "tool.parameters":         JSON.stringify({ tagName: "string", releaseName: "string", commits: "array", pullRequests: "array", previousTag: "string|null" }),
          "input.value":             JSON.stringify({ tagName: tag, releaseName: tag, commitCount: commits.length, prCount: pullRequests.length, previousTag }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const result = await generateReleaseNotes({ tagName: tag, releaseName: tag, commits, pullRequests, previousTag });
          s.setAttribute("output.value",             result.text.slice(0, 1000));
          s.setAttribute("output.mime_type",         "text/markdown");
          s.setAttribute("llm.token_count.prompt",   result.usage.inputTokens);
          s.setAttribute("llm.token_count.completion", result.usage.outputTokens);
          s.setAttribute("llm.token_count.total",    result.usage.totalTokens);
          s.setAttribute("llm.token_count.cache_read",  result.usage.cacheReadTokens);
          s.setAttribute("llm.token_count.cache_write", result.usage.cacheWriteTokens);
          return result;
        });

        const footer  = "\n\n---\n_Release notes generated by Louisa_";
        const created = await activeSpan(tracer, "github.create_release", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.createRelease",
          "tool.description":        "Publishes the AI-generated release notes as a GitHub Release for the tag",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", tag: "string", name: "string", body: "string" }),
          "input.value":             JSON.stringify({ owner, repo, tag }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const r = await createRelease(owner, repo, tag, tag, notes + footer);
          s.setAttribute("output.value",     r.html_url || "");
          s.setAttribute("output.mime_type", "text/plain");
          return r;
        });

        const releaseUrl = created.html_url;
        await activeSpan(tracer, "slack.post_notification", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "notifications.postReleaseNotification",
          "tool.description":        "Posts a release notification to configured channels (Slack and/or Teams) via Incoming Webhook",
          "tool.parameters":         JSON.stringify({ tag: "string", releaseUrl: "string", notes: "string" }),
          "input.value":             JSON.stringify({ tag, releaseUrl }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          await postReleaseNotification(tag, releaseUrl, notes);
          s.setAttribute("output.value",     "notification sent");
          s.setAttribute("output.mime_type", "text/plain");
        });

        rootSpan.setAttribute("output.value",     releaseUrl);
        rootSpan.setAttribute("output.mime_type", "text/plain");
        console.log(`Louisa: release created for tag ${tag}`);
        return { ok: true, tag, action: "created" };
      });

      await forceFlush();
      return res.status(200).json(result);
    } catch (err) {
      console.error("Louisa: error creating release from tag", err);
      await forceFlush();
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Manual publish: fill in empty release notes ────────────────────────────
  if (event === "release" && payload.action === "published") {
    const release = payload.release;
    if (release.draft) {
      return res.status(200).json({ skipped: true, reason: "draft" });
    }

    if (release.prerelease || release.tag_name.includes("-dev")) {
      console.log(`Louisa: skipping non-production release ${release.tag_name}`);
      return res.status(200).json({ skipped: true, reason: "non-production release" });
    }

    if (release.body && release.body.includes("Release notes generated by Louisa")) {
      console.log(`Louisa: notes already present for ${release.tag_name}, skipping`);
      return res.status(200).json({ skipped: true, reason: "notes already written" });
    }

    const owner     = payload.repository.owner.login;
    const repo      = payload.repository.name;
    const tag       = release.tag_name;
    const releaseId = release.id;

    console.log(`Louisa: processing published release ${tag} (id=${releaseId})`);

    try {
      const result = await activeSpan(tracer, "louisa.github.release.update", {
        "openinference.span.kind": "CHAIN",
        "agent.name":              "Louisa",
        "input.value":             JSON.stringify({ event: "release_published", tag, repository: `${owner}/${repo}`, releaseId }),
        "input.mime_type":         "application/json",
        "tag":                     tag,
        "repository":              `${owner}/${repo}`,
      }, async (rootSpan) => {

        const previousTag = await activeSpan(tracer, "github.get_previous_tag", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.getPreviousReleaseTag",
          "tool.description":        "Finds the most recent release tag before the given tag to determine the commit diff range",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", tag: "string" }),
          "input.value":             JSON.stringify({ owner, repo, tag }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const r = await getPreviousReleaseTag(owner, repo, tag);
          s.setAttribute("output.value",     r || "(none)");
          s.setAttribute("output.mime_type", "text/plain");
          return r;
        });
        console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

        const commits = await activeSpan(tracer, "github.get_commits", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.getCommitsBetweenTags",
          "tool.description":        "Retrieves all commits between two tags to identify what changed in this release",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", base: "string", head: "string" }),
          "input.value":             JSON.stringify({ owner, repo, base: previousTag, head: tag }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const r = await getCommitsBetweenTags(owner, repo, previousTag, tag);
          s.setAttribute("output.value",     JSON.stringify(r.map(c => ({ sha: c.sha.slice(0, 7), message: c.message }))));
          s.setAttribute("output.mime_type", "application/json");
          return r;
        });
        console.log(`Louisa: found ${commits.length} commits`);

        const [fromTagDate, toTagDate] = await Promise.all([
          previousTag ? getTagDate(owner, repo, previousTag) : Promise.resolve(null),
          getTagDate(owner, repo, tag),
        ]);
        const pullRequests = await activeSpan(tracer, "github.get_pull_requests", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.getPRsForRelease",
          "tool.description":        "Resolves merged PRs for the release window — reads pre-computed summaries from log if available, falls back to GitHub Search API",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", fromDate: "string", toDate: "string" }),
          "input.value":             JSON.stringify({ owner, repo, fromDate: fromTagDate, toDate: toTagDate }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          if (previousTag && !fromTagDate) {
            console.warn(`Louisa: could not resolve date for previous tag ${previousTag} — skipping PR fetch to avoid epoch-range query`);
            s.setAttribute("output.value",     "[]");
            s.setAttribute("output.mime_type", "application/json");
            return [];
          }
          const from = fromTagDate || new Date(0).toISOString();
          const to   = toTagDate
            ? new Date(new Date(toTagDate).getTime() + 10 * 60 * 1000).toISOString()
            : new Date().toISOString();

          // Try the local summaries log first — populated at PR merge time
          const cached = readSummariesInRange(`${owner}/${repo}`, from, to);
          if (cached !== null) {
            console.log(`Louisa: using ${cached.length} pre-computed PR summaries from log`);
            s.setAttribute("output.value",     JSON.stringify(cached.map(e => ({ number: e.number, title: e.title }))));
            s.setAttribute("output.mime_type", "application/json");
            return cached.map((entry) => ({
              number: entry.number,
              title:  entry.title,
              body:   `**Summary:** ${entry.summary}\n\n**User Impact:** ${entry.userImpact}\n\n**Type:** ${entry.type}`,
              author: entry.author,
              labels: entry.labels || [],
              url:    entry.url,
            }));
          }

          // Summaries log absent — fall back to live GitHub Search API
          console.log(`Louisa: summaries log not found, fetching PRs from GitHub API`);
          const r = await getPRsByDateRange(owner, repo, from, to);
          s.setAttribute("output.value",     JSON.stringify(r.map(pr => ({ number: pr.number, title: pr.title }))));
          s.setAttribute("output.mime_type", "application/json");
          return r;
        });
        console.log(`Louisa: found ${pullRequests.length} merged PRs`);

        const { text: notes } = await activeSpan(tracer, "louisa.generate_release_notes", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "louisa.generateReleaseNotes",
          "tool.description":        "Calls Claude to write polished release notes from commits and pull requests",
          "tool.parameters":         JSON.stringify({ tagName: "string", releaseName: "string", commits: "array", pullRequests: "array", previousTag: "string|null" }),
          "input.value":             JSON.stringify({ tagName: tag, releaseName: release.name || tag, commitCount: commits.length, prCount: pullRequests.length, previousTag }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const result = await generateReleaseNotes({ tagName: tag, releaseName: release.name || tag, commits, pullRequests, previousTag });
          s.setAttribute("output.value",               result.text.slice(0, 1000));
          s.setAttribute("output.mime_type",           "text/markdown");
          s.setAttribute("llm.token_count.prompt",     result.usage.inputTokens);
          s.setAttribute("llm.token_count.completion", result.usage.outputTokens);
          s.setAttribute("llm.token_count.total",      result.usage.totalTokens);
          s.setAttribute("llm.token_count.cache_read",  result.usage.cacheReadTokens);
          s.setAttribute("llm.token_count.cache_write", result.usage.cacheWriteTokens);
          return result;
        });

        const footer = "\n\n---\n_Release notes generated by Louisa_";
        await activeSpan(tracer, "github.update_release", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.updateReleaseBody",
          "tool.description":        "Updates an existing GitHub Release body with the AI-generated release notes",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", releaseId: "integer", body: "string" }),
          "input.value":             JSON.stringify({ owner, repo, releaseId }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          await updateReleaseBody(owner, repo, releaseId, notes + footer);
          s.setAttribute("output.value",     "updated");
          s.setAttribute("output.mime_type", "text/plain");
        });

        const releaseUrl = release.html_url;
        await activeSpan(tracer, "slack.post_notification", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "notifications.postReleaseNotification",
          "tool.description":        "Posts a release notification to configured channels (Slack and/or Teams) via Incoming Webhook",
          "tool.parameters":         JSON.stringify({ tag: "string", releaseUrl: "string", notes: "string" }),
          "input.value":             JSON.stringify({ tag, releaseUrl }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          await postReleaseNotification(tag, releaseUrl, notes);
          s.setAttribute("output.value",     "notification sent");
          s.setAttribute("output.mime_type", "text/plain");
        });

        rootSpan.setAttribute("output.value",     releaseUrl);
        rootSpan.setAttribute("output.mime_type", "text/plain");
        console.log(`Louisa: release ${tag} updated successfully`);
        return { ok: true, tag, action: "updated" };
      });

      await forceFlush();
      return res.status(200).json(result);
    } catch (err) {
      console.error("Louisa: error updating release", err);
      await forceFlush();
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── PR merged: generate summary and append to log ───────────────────────────
  if (
    event === "pull_request" &&
    payload.action === "closed" &&
    payload.pull_request?.merged === true
  ) {
    const pr       = payload.pull_request;
    const owner    = payload.repository.owner.login;
    const repo     = payload.repository.name;
    const prNumber = pr.number;

    if (pr.draft) {
      return res.status(200).json({ skipped: true, reason: "draft PR" });
    }

    const { skip, reason: skipReason } = shouldSkipEnrichment({
      title:          pr.title,
      authorUsername: pr.user?.login ?? "",
      authorType:     pr.user?.type  ?? "",
    });
    if (skip) {
      console.log(`Louisa: skipping PR #${prNumber} — ${skipReason}`);
      return res.status(200).json({ skipped: true, reason: skipReason });
    }

    console.log(`Louisa: summarising merged PR #${prNumber} — "${pr.title}"`);

    try {
      const result = await activeSpan(tracer, "louisa.github.summarize_pr", {
        "openinference.span.kind": "CHAIN",
        "agent.name":              "Louisa",
        "input.value":             JSON.stringify({ event: "pr_merged", prNumber, repository: `${owner}/${repo}` }),
        "input.mime_type":         "application/json",
        "pr_number":               String(prNumber),
        "repository":              `${owner}/${repo}`,
      }, async (rootSpan) => {

        const [commits, files, comments] = await activeSpan(tracer, "github.get_pr_context", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.getPRContext",
          "tool.description":        "Fetches commits, changed files, and review comments from the merged PR",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", prNumber: "integer" }),
          "input.value":             JSON.stringify({ owner, repo, prNumber }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const [c, f, co] = await Promise.all([
            getPRCommits(owner, repo, prNumber),
            getPRFiles(owner, repo, prNumber),
            getPRComments(owner, repo, prNumber),
          ]);
          s.setAttribute("output.value",     JSON.stringify({ commits: c.length, files: f.length, comments: co.length }));
          s.setAttribute("output.mime_type", "application/json");
          return [c, f, co];
        });

        const { summary, type, userImpact } = await activeSpan(tracer, "louisa.summarize_pr", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "louisa.summarizePR",
          "tool.description":        "Calls Claude to generate a compact summary of the PR for the summaries log",
          "tool.parameters":         JSON.stringify({ platform: "string", title: "string", body: "string", commits: "array", files: "array", comments: "array" }),
          "input.value":             JSON.stringify({ prNumber, title: pr.title }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const r = await summarizePR({
            platform: "github",
            title:    pr.title,
            body:     pr.body || "",
            commits,
            files,
            comments,
          });
          s.setAttribute("output.value",     r.summary);
          s.setAttribute("output.mime_type", "text/plain");
          return r;
        });

        appendSummary({
          platform:   "github",
          repo:       `${owner}/${repo}`,
          number:     prNumber,
          title:      pr.title,
          summary,
          type,
          userImpact,
          author:     pr.user?.login,
          labels:     (pr.labels || []).map((l) => l.name),
          url:        pr.html_url,
          mergedAt:   pr.merged_at,
        });

        rootSpan.setAttribute("output.value",     `PR #${prNumber} summarised`);
        rootSpan.setAttribute("output.mime_type", "text/plain");
        console.log(`Louisa: PR #${prNumber} summarised (${type})`);
        return { ok: true, prNumber, action: "summarised", type };
      });

      await forceFlush();
      return res.status(200).json(result);
    } catch (err) {
      console.error(`Louisa: error summarising PR #${prNumber}`, err);
      await forceFlush();
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(200).json({ skipped: true, reason: `event=${event}` });
}
