#!/usr/bin/env node
/**
 * test-release-notes-span.js — Verify the spans and requests behind release
 * notes, against a local mock of the Anthropic API (no real API calls).
 *
 * Tests:
 *   1. With MRs: the release-notes LLM call is a child of a
 *      louisa.write_release_notes span whose output.value is the notes text
 *   2. With no MRs: no louisa.write_release_notes span is created
 *   3. Release-notes request: claude-opus-5-5, max_tokens 16000, effort medium
 *   4. Refusal and max_tokens stop reasons throw instead of returning notes
 *   5. Per-MR summary request: claude-haiku-5-5 with the forced record_summary tool
 *
 * Run: node scripts/test-release-notes-span.js
 */

import http from "http";
import Anthropic from "@anthropic-ai/sdk";
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Mock Anthropic API ────────────────────────────────────────────────────────

const NOTES = "# Arthur Platform Release\n\n## Agent Discovery\n\n* Added the Scans tab (!1547)";
const requests = [];
let nextStopReason = "end_turn";

function mockMessage(body) {
  const content = body.tools
    ? [{ type: "tool_use", id: "toolu_1", name: "record_summary",
         input: { type: "Feature", summary: "Added scans.", userImpact: "Users can scan." } }]
    : [{ type: "thinking", thinking: "", signature: "sig" },
       { type: "text", text: nextStopReason === "refusal" ? "" : NOTES }];
  return {
    id: "msg_test", type: "message", role: "assistant", model: body.model, content,
    stop_reason: body.tools ? "tool_use" : nextStopReason,
    stop_details: nextStopReason === "refusal" ? { type: "refusal", category: "cyber" } : null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(mockMessage(body)));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.ANTHROPIC_API_KEY  = "test-key";
delete process.env.ARTHUR_BASE_URL; // prompts fall back to the hardcoded text

// ── Tracing, set up the way lib/otel.js does it, but kept in memory ──────────

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
new AnthropicInstrumentation().manuallyInstrument(Anthropic);
provider.register();
const tracer = trace.getTracer("louisa-test");

// Import after instrumenting, as the real entry points do via getTracer().
const { writePlatformReleaseNotes } = await import("../lib/claude-platform.js");
const { summarizePR } = await import("../lib/claude.js");

const baseArgs = {
  tagName: "1.4.9999-success-aws-prod-platform",
  releaseName: "1.4.9999-success-aws-prod-platform",
  commits: [{ sha: "abc123", message: "Add scans tab", author: "dev" }],
  previousTag: "1.4.9998-success-aws-prod-platform",
};
const oneMR = [{ number: 1547, title: "Add scans tab", author: "dev", labels: [], body: "" }];

// ── Test 1: with MRs, the notes call is wrapped ──────────────────────────────
console.log("\nTest 1: louisa.write_release_notes wraps the release-notes call");
{
  exporter.reset();
  const result = await writePlatformReleaseNotes(tracer, { ...baseArgs, mergeRequests: oneMR });
  const spans   = exporter.getFinishedSpans();
  const wrapper = spans.find((s) => s.name === "louisa.write_release_notes");
  const llm     = spans.find((s) => s.name === "Anthropic Messages");
  const parentId = llm?.parentSpanContext?.spanId ?? llm?.parentSpanId;
  assert(result.text === NOTES, "returns the notes text");
  assert(!!wrapper, "louisa.write_release_notes span exists");
  assert(!!llm && parentId === wrapper?.spanContext().spanId, "Anthropic Messages is its child");
  assert(wrapper?.attributes["output.value"] === NOTES, "output.value is the notes markdown");
  assert(wrapper?.attributes["output.mime_type"] === "text/markdown", "output.mime_type is text/markdown");
  assert(JSON.parse(wrapper?.attributes["input.value"] ?? "{}").mrCount === 1, "input.value records mrCount");
}

// ── Test 2: with no MRs, no wrapper span ─────────────────────────────────────
console.log("\nTest 2: no MRs → no louisa.write_release_notes span");
{
  exporter.reset();
  await writePlatformReleaseNotes(tracer, { ...baseArgs, mergeRequests: [] });
  const names = exporter.getFinishedSpans().map((s) => s.name);
  assert(!names.includes("louisa.write_release_notes"), "no wrapper span");
  assert(names.includes("Anthropic Messages"), "the LLM call is still traced");
}

// ── Test 3: release-notes request parameters ─────────────────────────────────
console.log("\nTest 3: release-notes request uses Opus 5.5 settings");
{
  const body = requests.at(-1);
  assert(body.model === "claude-opus-5-5", "model is claude-opus-5-5");
  assert(body.max_tokens === 16000, "max_tokens is 16000");
  assert(body.output_config?.effort === "medium", "effort is medium");
  assert(body.thinking === undefined && body.temperature === undefined, "no thinking or temperature override");
}

// ── Test 4: unusable responses throw ─────────────────────────────────────────
console.log("\nTest 4: refusal and max_tokens throw");
for (const stop of ["refusal", "max_tokens"]) {
  nextStopReason = stop;
  let error = null;
  try {
    await writePlatformReleaseNotes(tracer, { ...baseArgs, mergeRequests: oneMR });
  } catch (err) {
    error = err;
  }
  assert(error && error.message.includes(stop === "refusal" ? "refusal" : "max_tokens"), `${stop} → throws`);
}
nextStopReason = "end_turn";

// ── Test 5: per-MR summary request ───────────────────────────────────────────
console.log("\nTest 5: per-MR summary uses Haiku 5.5 with the forced tool");
{
  const summary = await summarizePR({
    platform: "gitlab", title: "Add scans tab", body: "", commits: [], files: [], comments: [],
  });
  const body = requests.at(-1);
  assert(body.model === "claude-haiku-5-5", "model is claude-haiku-5-5");
  assert(body.tool_choice?.type === "tool" && body.tool_choice?.name === "record_summary", "tool_choice forces record_summary");
  assert(summary.type === "Feature", "parses the tool_use result");
}

server.close();
await provider.shutdown();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
