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
import { createTrace, traced } from "../lib/tracing.js";

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

  // --- Tag push: generate and publish new release ---
  if (event === "create" && payload.ref_type === "tag") {
    const tag = payload.ref;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;

    console.log(`Louisa: new tag detected — ${tag}`);

    const trace = createTrace();
    const root = trace.span("louisa.github.release", null, [
      ["openinference.span.kind", "CHAIN"],
      ["input.value", JSON.stringify({ tag, repository: `${owner}/${repo}` })],
      ["input.mime_type", "application/json"],
      ["tag", tag],
      ["repository", `${owner}/${repo}`],
    ]);

    try {
      const existing = await getReleaseByTag(owner, repo, tag);
      if (existing) {
        console.log(`Louisa: release already exists for ${tag}, skipping`);
        root.addAttr("output.value", "skipped: release already exists");
        root.addAttr("output.mime_type", "text/plain");
        root.end();
        await trace.send().catch(() => {});
        return res.status(200).json({ skipped: true, reason: "release already exists" });
      }

      const previousTag = await traced(
        trace,
        "github.get_previous_tag",
        [
          ["openinference.span.kind", "TOOL"],
          ["tool.name", "github.getPreviousReleaseTag"],
          ["input.value", JSON.stringify({ owner, repo, tag })],
          ["input.mime_type", "application/json"],
        ],
        root.spanId,
        async (s) => {
          const result = await getPreviousReleaseTag(owner, repo, tag);
          s.addAttr("output.value", result || "(none)");
          s.addAttr("output.mime_type", "text/plain");
          return result;
        }
      );
      console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

      const commits = await traced(
        trace,
        "github.get_commits",
        [
          ["openinference.span.kind", "TOOL"],
          ["tool.name", "github.getCommitsBetweenTags"],
          ["input.value", JSON.stringify({ owner, repo, base: previousTag, head: tag })],
          ["input.mime_type", "application/json"],
        ],
        root.spanId,
        async (s) => {
          const result = await getCommitsBetweenTags(owner, repo, previousTag, tag);
          s.addAttr("output.value", JSON.stringify(result.map(c => ({ sha: c.sha.slice(0, 7), message: c.message }))));
          s.addAttr("output.mime_type", "application/json");
          return result;
        }
      );
      console.log(`Louisa: found ${commits.length} commits`);

      const shas = commits.map((c) => c.sha);
      const pullRequests = await traced(
        trace,
        "github.get_pull_requests",
        [
          ["openinference.span.kind", "TOOL"],
          ["tool.name", "github.getPullRequestsForCommits"],
          ["input.value", JSON.stringify({ owner, repo, commitCount: shas.length })],
          ["input.mime_type", "application/json"],
        ],
        root.spanId,
        async (s) => {
          const result = await getPullRequestsForCommits(owner, repo, shas);
          s.addAttr("output.value", JSON.stringify(result.map(pr => ({ number: pr.number, title: pr.title }))));
          s.addAttr("output.mime_type", "application/json");
          return result;
        }
      );
      console.log(`Louisa: found ${pullRequests.length} merged PRs`);

      const { text: notes, usage, systemPrompt, userContent } = await traced(
        trace,
        "claude.generate_release_notes",
        [
          ["openinference.span.kind", "LLM"],
          ["llm.model_name", "claude-sonnet-4-20250514"],
          ["llm.invocation_parameters", JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4096 })],
        ],
        root.spanId,
        async (s) => {
          const result = await generateReleaseNotes({ tagName: tag, releaseName: tag, commits, pullRequests, previousTag });
          s.addAttr("llm.system", result.systemPrompt);
          s.addAttr("llm.input_messages.0.message.role", "user");
          s.addAttr("llm.input_messages.0.message.content", result.userContent);
          s.addAttr("llm.output_messages.0.message.role", "assistant");
          s.addAttr("llm.output_messages.0.message.content", result.text);
          s.addAttr("llm.token_count.prompt", result.usage.inputTokens);
          s.addAttr("llm.token_count.completion", result.usage.outputTokens);
          s.addAttr("llm.token_count.total", result.usage.totalTokens);
          s.addAttr("input.value", result.userContent);
          s.addAttr("input.mime_type", "text/plain");
          s.addAttr("output.value", result.text);
          s.addAttr("output.mime_type", "text/plain");
          return result;
        }
      );

      const footer = "\n\n---\n_Release notes generated by Louisa_";
      const created = await traced(
        trace,
        "github.create_release",
        [
          ["openinference.span.kind", "TOOL"],
          ["tool.name", "github.createRelease"],
          ["input.value", JSON.stringify({ owner, repo, tag })],
          ["input.mime_type", "application/json"],
        ],
        root.spanId,
        async (s) => {
          const result = await createRelease(owner, repo, tag, tag, notes + footer);
          s.addAttr("output.value", result.html_url || "");
          s.addAttr("output.mime_type", "text/plain");
          return result;
        }
      );

      const releaseUrl = created.html_url;
      await traced(
        trace,
        "slack.post_notification",
        [
          ["openinference.span.kind", "TOOL"],
          ["tool.name", "slack.postReleaseToSlack"],
          ["input.value", JSON.stringify({ tag, releaseUrl })],
          ["input.mime_type", "application/json"],
        ],
        root.spanId,
        async (s) => {
          await postReleaseToSlack(tag, releaseUrl, notes);
          s.addAttr("output.value", "sent");
          s.addAttr("output.mime_type", "text/plain");
        }
      );

      root.addAttr("output.value", releaseUrl);
      root.addAttr("output.mime_type", "text/plain");
      root.end();
      console.log(`Louisa: release created for tag ${tag}`);
      await trace.send().catch(() => {});
      return res.status(200).json({ ok: true, tag, action: "created" });
    } catch (err) {
      root.end(err);
      console.error("Louisa: error creating release from tag", err);
      await trace.send().catch(() => {});
      return res.status(500).json({ error: err.message });
    }
  }

  // --- Manual publish: fill in empty release notes ---
  if (event === "release" && payload.action === "published") {
    const release = payload.release;
    if (release.draft) {
      return res.status(200).json({ skipped: true, reason: "draft" });
    }

    if (release.body && release.body.includes("Release notes generated by Louisa")) {
      console.log(`Louisa: notes already present for ${release.tag_name}, skipping`);
      return res.status(200).json({ skipped: true, reason: "notes already written" });
    }

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const tag = release.tag_name;
    const releaseId = release.id;

    console.log(`Louisa: processing published release ${tag} (id=${releaseId})`);

    const trace = createTrace();
    const root = trace.span("louisa.github.release.update", null, [
      ["openinference.span.kind", "CHAIN"],
      ["input.value", JSON.stringify({ tag, repository: `${owner}/${repo}`, releaseId })],
      ["input.mime_type", "application/json"],
      ["tag", tag],
      ["repository", `${owner}/${repo}`],
    ]);

    try {
      const previousTag = await traced(
        trace,
        "github.get_previous_tag",
        [
          ["openinference.span.kind", "TOOL"],
          ["tool.name", "github.getPreviousReleaseTag"],
          ["input.value", JSON.stringify({ owner, repo, tag })],
          ["input.mime_type", "application/json"],
        ],
        root.spanId,
        async (s) => {
          const result = await getPreviousReleaseTag(owner, repo, tag);
          s.addAttr("output.value", result || "(none)");
          s.addAttr("output.mime_type", "text/plain");
          return result;
        }
      );
      console.log(`Louisa: comparing ${previousTag || "(none)"} → ${tag}`);

      const commits = await traced(
        trace,
        "github.get_commits",
        [
          ["openinference.span.kind", "TOOL"],
          ["tool.name", "github.getCommitsBetweenTags"],
          ["input.value", JSON.stringify({ owner, repo, base: previousTag, head: tag })],
          ["input.mime_type", "application/json"],
        ],
        root.spanId,
        async (s) => {
          const result = await getCommitsBetweenTags(owner, repo, previousTag, tag);
          s.addAttr("output.value", JSON.stringify(result.map(c => ({ sha: c.sha.slice(0, 7), message: c.message }))));
          s.addAttr("output.mime_type", "application/json");
          return result;
        }
      );
      console.log(`Louisa: found ${commits.length} commits`);

      const shas = commits.map((c) => c.sha);
      const pullRequests = await traced(
        trace,
        "github.get_pull_requests",
        [
          ["openinference.span.kind", "TOOL"],
          ["tool.name", "github.getPullRequestsForCommits"],
          ["input.value", JSON.stringify({ owner, repo, commitCount: shas.length })],
          ["input.mime_type", "application/json"],
        ],
        root.spanId,
        async (s) => {
          const result = await getPullRequestsForCommits(owner, repo, shas);
          s.addAttr("output.value", JSON.stringify(result.map(pr => ({ number: pr.number, title: pr.title }))));
          s.addAttr("output.mime_type", "application/json");
          return result;
        }
      );
      console.log(`Louisa: found ${pullRequests.length} merged PRs`);

      const { text: notes, usage, systemPrompt, userContent } = await traced(
        trace,
        "claude.generate_release_notes",
        [
          ["openinference.span.kind", "LLM"],
          ["llm.model_name", "claude-sonnet-4-20250514"],
          ["llm.invocation_parameters", JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4096 })],
        ],
        root.spanId,
        async (s) => {
          const result = await generateReleaseNotes({ tagName: tag, releaseName: release.name || tag, commits, pullRequests, previousTag });
          s.addAttr("llm.system", result.systemPrompt);
          s.addAttr("llm.input_messages.0.message.role", "user");
          s.addAttr("llm.input_messages.0.message.content", result.userContent);
          s.addAttr("llm.output_messages.0.message.role", "assistant");
          s.addAttr("llm.output_messages.0.message.content", result.text);
          s.addAttr("llm.token_count.prompt", result.usage.inputTokens);
          s.addAttr("llm.token_count.completion", result.usage.outputTokens);
          s.addAttr("llm.token_count.total", result.usage.totalTokens);
          s.addAttr("input.value", result.userContent);
          s.addAttr("input.mime_type", "text/plain");
          s.addAttr("output.value", result.text);
          s.addAttr("output.mime_type", "text/plain");
          return result;
        }
      );

      const footer = "\n\n---\n_Release notes generated by Louisa_";
      await traced(
        trace,
        "github.update_release",
        [
          ["openinference.span.kind", "TOOL"],
          ["tool.name", "github.updateReleaseBody"],
          ["input.value", JSON.stringify({ owner, repo, releaseId })],
          ["input.mime_type", "application/json"],
        ],
        root.spanId,
        async (s) => {
          await updateReleaseBody(owner, repo, releaseId, notes + footer);
          s.addAttr("output.value", "updated");
          s.addAttr("output.mime_type", "text/plain");
        }
      );

      const releaseUrl = release.html_url;
      await traced(
        trace,
        "slack.post_notification",
        [
          ["openinference.span.kind", "TOOL"],
          ["tool.name", "slack.postReleaseToSlack"],
          ["input.value", JSON.stringify({ tag, releaseUrl })],
          ["input.mime_type", "application/json"],
        ],
        root.spanId,
        async (s) => {
          await postReleaseToSlack(tag, releaseUrl, notes);
          s.addAttr("output.value", "sent");
          s.addAttr("output.mime_type", "text/plain");
        }
      );

      root.addAttr("output.value", releaseUrl);
      root.addAttr("output.mime_type", "text/plain");
      root.end();
      console.log(`Louisa: release ${tag} updated successfully`);
      await trace.send().catch(() => {});
      return res.status(200).json({ ok: true, tag, action: "updated" });
    } catch (err) {
      root.end(err);
      console.error("Louisa: error updating release", err);
      await trace.send().catch(() => {});
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(200).json({ skipped: true, reason: `event=${event}` });
}
