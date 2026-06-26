import { waitUntil } from "@vercel/functions";
import { verifySlackSignature } from "../lib/crypto.js";
import { listReleasesSorted } from "../lib/github.js";
import { getProdTagsSorted, getReleaseByTag } from "../lib/gitlab.js";
import { summarizeVersionRange } from "../lib/claude.js";
import { postMessage, chunkForSlack } from "../lib/slack.js";
import {
  parseMentionIntent,
  normalizeVersion,
  selectReleasesBetween,
  concatReleaseNotes,
} from "../lib/version-range.js";
import { getTracer, forceFlush, activeSpan } from "../lib/otel.js";

export const config = { maxDuration: 300 };

const USAGE =
  "I can summarize what changed between two versions. Try:\n" +
  "`@Louisa give me platform changes between 1.4.1892 and 1.4.2227`\n" +
  "`@Louisa engine changes from 2.1.0 to 2.4.0`";

/**
 * Read the raw request body. Slack signs the unparsed bytes, so we must verify
 * against exactly what was received. Falls back to re-serializing req.body if
 * the stream was already consumed by Vercel's body parser.
 */
async function readRawBody(req) {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length) return Buffer.concat(chunks).toString("utf8");
  } catch {
    /* fall through */
  }
  if (typeof req.body === "string") return req.body;
  if (req.body) return JSON.stringify(req.body);
  return "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await readRawBody(req);

  // Ignore Slack's delivery retries to avoid duplicate replies.
  if (req.headers["x-slack-retry-num"]) {
    return res.status(200).json({ ok: true, ignored: "retry" });
  }

  const valid = verifySlackSignature(
    rawBody,
    req.headers["x-slack-request-timestamp"],
    req.headers["x-slack-signature"],
    process.env.SLACK_SIGNING_SECRET
  );
  if (!valid) {
    console.warn("Louisa: invalid Slack signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // Events API URL verification handshake.
  if (payload.type === "url_verification") {
    return res.status(200).json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback" && payload.event?.type === "app_mention") {
    const event = payload.event;
    // Ack immediately (Slack requires 200 within 3s), then do the work in the background.
    res.status(200).json({ ok: true });
    waitUntil(handleMention(event));
    return;
  }

  return res.status(200).json({ ok: true, ignored: payload.type });
}

/**
 * Strip the leading bot mention token, resolve the requested version range,
 * summarize it with Claude, and reply in the thread of the mention.
 */
async function handleMention(event) {
  const tracer = getTracer();
  const channel = event.channel;
  const thread_ts = event.thread_ts || event.ts;
  const text = (event.text || "").replace(/<@[^>]+>/g, "").trim();

  try {
    await activeSpan(
      tracer,
      "louisa.slack.version_summary",
      { "openinference.span.kind": "CHAIN", "agent.name": "Louisa", "input.value": text },
      async (span) => {
        const intent = parseMentionIntent(text);
        if (!intent) {
          await postMessage({ channel, thread_ts, text: USAGE });
          return;
        }

        const { product, v1, v2 } = intent;
        span.setAttribute("louisa.product", product);

        // Resolve the published releases between the two versions.
        const { from, to, releaseNotes } = await activeSpan(
          tracer,
          product === "platform" ? "gitlab.list_releases" : "github.list_releases",
          { "openinference.span.kind": "TOOL" },
          () => resolveRange(product, v1, v2)
        );

        const { text: summary } = await activeSpan(
          tracer,
          "louisa.summarize_version_range",
          { "openinference.span.kind": "TOOL", "tool.name": "summarizeVersionRange" },
          () =>
            summarizeVersionRange({
              product,
              fromVersion: from,
              toVersion: to,
              releaseNotes,
            })
        );

        const productName = product === "platform" ? "Arthur Platform" : "Arthur Engine";
        const header = `*${productName}* — what changed from \`${from}\` → \`${to}\``;
        const chunks = chunkForSlack(summary);

        await postMessage({ channel, thread_ts, text: `${header}\n\n${chunks[0]}` });
        for (const chunk of chunks.slice(1)) {
          await postMessage({ channel, thread_ts, text: chunk });
        }
        span.setAttribute("output.value", summary);
      }
    );
  } catch (err) {
    if (err instanceof RangeError) {
      // resolveRange signals user-facing problems (version not found, empty range).
      await postMessage({ channel, thread_ts, text: err.message });
    } else {
      console.error("Louisa: failed to handle mention", err);
      await postMessage({
        channel,
        thread_ts,
        text: "Sorry — something went wrong fetching those release notes. Check the logs.",
      });
    }
  } finally {
    await forceFlush();
  }
}

/**
 * Fetch the release list for the product, select the range, and concatenate the
 * notes. Throws a RangeError with a user-facing message for resolution problems.
 */
async function resolveRange(product, v1, v2) {
  let releases;
  if (product === "platform") {
    const projectId = process.env.GITLAB_PROJECT_ID;
    const prodSuffix = process.env.GITLAB_PROD_TAG_SUFFIX || "-success-aws-prod-platform";
    const tags = await getProdTagsSorted(projectId);
    const n1 = normalizeVersion(product, v1, prodSuffix);
    const n2 = normalizeVersion(product, v2, prodSuffix);

    const sel = selectReleasesBetween(
      tags.map((t) => ({ name: t.name, date: t.date })),
      n1,
      n2
    );
    if (!sel.ok) throw new RangeError(sel.error);

    // Pull each release's published description (the changelog Louisa generated).
    const withBodies = await Promise.all(
      sel.releases.map(async (r) => {
        const rel = await getReleaseByTag(projectId, r.name);
        return { name: r.name, date: r.date, body: rel?.description || "" };
      })
    );
    return { from: sel.from, to: sel.to, releaseNotes: concatReleaseNotes(withBodies) };
  }

  // engine
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  releases = (await listReleasesSorted(owner, repo)).map((r) => ({
    name: r.tag_name,
    body: r.body,
    date: r.date,
  }));
  const n1 = normalizeVersion(product, v1);
  const n2 = normalizeVersion(product, v2);
  const sel = selectReleasesBetween(releases, n1, n2);
  if (!sel.ok) throw new RangeError(sel.error);
  return { from: sel.from, to: sel.to, releaseNotes: concatReleaseNotes(sel.releases) };
}
