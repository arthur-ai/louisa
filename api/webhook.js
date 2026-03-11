import { verifyGitHubSignature } from "../lib/crypto.js";
import {
  getCommitsBetweenTags,
  getPullRequestsForCommits,
  getPreviousReleaseTag,
  getReleaseByTag,
  createRelease,
  updateReleaseBody,
} from "../lib/github.js";
import { generateReleaseNotes } from "../lib/claude.js";
import { postReleaseToSlack } from "../lib/slack.js";
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

        const shas = commits.map((c) => c.sha);
        const pullRequests = await activeSpan(tracer, "github.get_pull_requests", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.getPullRequestsForCommits",
          "tool.description":        "Fetches merged pull requests associated with the release commits to enrich release notes with context",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", shas: "string[]" }),
          "input.value":             JSON.stringify({ owner, repo, commitCount: shas.length }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const r = await getPullRequestsForCommits(owner, repo, shas);
          s.setAttribute("output.value",     JSON.stringify(r.map(pr => ({ number: pr.number, title: pr.title }))));
          s.setAttribute("output.mime_type", "application/json");
          return r;
        });
        console.log(`Louisa: found ${pullRequests.length} merged PRs`);

        // generateReleaseNotes() calls client.messages.create() internally.
        // AnthropicInstrumentation auto-creates an LLM span as a child of rootSpan.
        const { text: notes } = await generateReleaseNotes({ tagName: tag, releaseName: tag, commits, pullRequests, previousTag });

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
          "tool.name":               "slack.postReleaseToSlack",
          "tool.description":        "Posts a release summary to the Slack #releases channel via Incoming Webhook",
          "tool.parameters":         JSON.stringify({ tag: "string", releaseUrl: "string", notes: "string" }),
          "input.value":             JSON.stringify({ tag, releaseUrl }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          await postReleaseToSlack(tag, releaseUrl, notes);
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

        const shas = commits.map((c) => c.sha);
        const pullRequests = await activeSpan(tracer, "github.get_pull_requests", {
          "openinference.span.kind": "TOOL",
          "tool.name":               "github.getPullRequestsForCommits",
          "tool.description":        "Fetches merged pull requests associated with the release commits to enrich release notes with context",
          "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", shas: "string[]" }),
          "input.value":             JSON.stringify({ owner, repo, commitCount: shas.length }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          const r = await getPullRequestsForCommits(owner, repo, shas);
          s.setAttribute("output.value",     JSON.stringify(r.map(pr => ({ number: pr.number, title: pr.title }))));
          s.setAttribute("output.mime_type", "application/json");
          return r;
        });
        console.log(`Louisa: found ${pullRequests.length} merged PRs`);

        // AnthropicInstrumentation auto-creates an LLM span as a child of rootSpan.
        const { text: notes } = await generateReleaseNotes({ tagName: tag, releaseName: release.name || tag, commits, pullRequests, previousTag });

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
          "tool.name":               "slack.postReleaseToSlack",
          "tool.description":        "Posts a release summary to the Slack #releases channel via Incoming Webhook",
          "tool.parameters":         JSON.stringify({ tag: "string", releaseUrl: "string", notes: "string" }),
          "input.value":             JSON.stringify({ tag, releaseUrl }),
          "input.mime_type":         "application/json",
        }, async (s) => {
          await postReleaseToSlack(tag, releaseUrl, notes);
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

  return res.status(200).json({ skipped: true, reason: `event=${event}` });
}
