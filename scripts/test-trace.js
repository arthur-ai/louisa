/**
 * Manual trace test for Louisa.
 *
 * Fires a realistic CHAIN → TOOL → LLM → TOOL trace against Arthur Engine
 * using a tiny Claude prompt so the whole stack can be verified without
 * pushing an actual tag.
 *
 * Usage:
 *   node scripts/test-trace.js
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env.local before any other imports that read env vars.
// (Node's --env-file flag misses some .env formats; this parser handles them all.)
const __dir = dirname(fileURLToPath(import.meta.url));
try {
  const raw = readFileSync(resolve(__dir, "../.env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // File always wins — even if the key exists in env but is empty
    if (key && val) process.env[key] = val;
  }
} catch {
  // .env.local not found — rely on environment already being set
}

import { getTracer, forceFlush, activeSpan } from "../lib/otel.js";
import Anthropic from "@anthropic-ai/sdk";

// ─── Fake release data ────────────────────────────────────────────────────────
const FAKE_TAG  = "v0.0.0-trace-test";
const FAKE_REPO = "louisa-trace-test";
const FAKE_COMMITS = [
  { sha: "abc1234", message: "feat: add observability via Arthur Engine", author: "test-bot" },
  { sha: "def5678", message: "fix: flush spans before serverless function returns", author: "test-bot" },
];
const FAKE_PRS = [
  { number: 42, title: "Add OpenInference tracing", author: "test-bot", labels: ["observability"], body: "Instruments every release run with OTLP spans." },
];

// ─── Minimal Claude call ──────────────────────────────────────────────────────
// Bypasses generateReleaseNotes() so we can keep prompt tokens tiny.
async function callClaude() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 64,
    system: "You are a test assistant. Respond in one sentence only.",
    messages: [{ role: "user", content: "Say: Louisa trace test successful." }],
  });
  return msg.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Louisa trace test — starting…\n");

  const tracer = getTracer();

  const result = await activeSpan(tracer, "louisa.github.release", {
    "openinference.span.kind": "CHAIN",
    "agent.name":              "Louisa",
    "input.value":             JSON.stringify({ event: "tag_push", tag: FAKE_TAG, repository: `test-org/${FAKE_REPO}` }),
    "input.mime_type":         "application/json",
    "tag":                     FAKE_TAG,
    "repository":              `test-org/${FAKE_REPO}`,
  }, async (rootSpan) => {

    // ── TOOL: get previous tag ──────────────────────────────────────────────
    const previousTag = await activeSpan(tracer, "github.get_previous_tag", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "github.getPreviousReleaseTag",
      "tool.description":        "Finds the most recent release tag before the given tag to determine the commit diff range",
      "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", tag: "string" }),
      "input.value":             JSON.stringify({ owner: "test-org", repo: FAKE_REPO, tag: FAKE_TAG }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      await sleep(30); // simulate API latency
      const result = "v0.0.0-prev";
      s.setAttribute("output.value",     result);
      s.setAttribute("output.mime_type", "text/plain");
      console.log(`  [TOOL] github.get_previous_tag → ${result}`);
      return result;
    });

    // ── TOOL: get commits ───────────────────────────────────────────────────
    const commits = await activeSpan(tracer, "github.get_commits", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "github.getCommitsBetweenTags",
      "tool.description":        "Retrieves all commits between two tags to identify what changed in this release",
      "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", base: "string", head: "string" }),
      "input.value":             JSON.stringify({ owner: "test-org", repo: FAKE_REPO, base: previousTag, head: FAKE_TAG }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      await sleep(40);
      s.setAttribute("output.value",     JSON.stringify(FAKE_COMMITS.map(c => ({ sha: c.sha, message: c.message }))));
      s.setAttribute("output.mime_type", "application/json");
      console.log(`  [TOOL] github.get_commits → ${FAKE_COMMITS.length} commits`);
      return FAKE_COMMITS;
    });

    // ── TOOL: get pull requests ─────────────────────────────────────────────
    const prs = await activeSpan(tracer, "github.get_pull_requests", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "github.getPullRequestsForCommits",
      "tool.description":        "Fetches merged pull requests associated with the release commits",
      "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", shas: "string[]" }),
      "input.value":             JSON.stringify({ owner: "test-org", repo: FAKE_REPO, commitCount: commits.length }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      await sleep(35);
      s.setAttribute("output.value",     JSON.stringify(FAKE_PRS.map(pr => ({ number: pr.number, title: pr.title }))));
      s.setAttribute("output.mime_type", "application/json");
      console.log(`  [TOOL] github.get_pull_requests → ${FAKE_PRS.length} PRs`);
      return FAKE_PRS;
    });

    // ── LLM: Claude call (auto-instrumented) ────────────────────────────────
    // AnthropicInstrumentation wraps client.messages.create() and emits
    // the LLM span automatically as a child of this CHAIN span.
    console.log("  [LLM]  calling Claude (haiku, 64 tokens max)…");
    const notes = await callClaude();
    console.log(`  [LLM]  response: "${notes}"`);

    // ── TOOL: create release ────────────────────────────────────────────────
    const releaseUrl = await activeSpan(tracer, "github.create_release", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "github.createRelease",
      "tool.description":        "Publishes the AI-generated release notes as a GitHub Release for the tag",
      "tool.parameters":         JSON.stringify({ owner: "string", repo: "string", tag: "string", name: "string", body: "string" }),
      "input.value":             JSON.stringify({ owner: "test-org", repo: FAKE_REPO, tag: FAKE_TAG }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      await sleep(50);
      const url = `https://github.com/test-org/${FAKE_REPO}/releases/tag/${FAKE_TAG}`;
      s.setAttribute("output.value",     url);
      s.setAttribute("output.mime_type", "text/plain");
      console.log(`  [TOOL] github.create_release → ${url}`);
      return url;
    });

    // ── TOOL: Slack notification ────────────────────────────────────────────
    await activeSpan(tracer, "slack.post_notification", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "slack.postReleaseToSlack",
      "tool.description":        "Posts a release summary to the Slack #releases channel",
      "tool.parameters":         JSON.stringify({ tag: "string", releaseUrl: "string", notes: "string" }),
      "input.value":             JSON.stringify({ tag: FAKE_TAG, releaseUrl }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      await sleep(25);
      s.setAttribute("output.value",     "notification sent");
      s.setAttribute("output.mime_type", "text/plain");
      console.log("  [TOOL] slack.post_notification → sent");
    });

    rootSpan.setAttribute("output.value",     releaseUrl);
    rootSpan.setAttribute("output.mime_type", "text/plain");
    return { tag: FAKE_TAG, releaseUrl };
  });

  console.log("\nFlushing spans to Arthur Engine…");
  await forceFlush();
  console.log("Done. Check the Arthur dashboard for a trace labelled:");
  console.log(`  service: louisa  |  root span: louisa.github.release  |  tag: ${result.tag}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
