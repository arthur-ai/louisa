/**
 * Eval: Thematic Section Placement
 *
 * Evaluates whether each bullet point in Louisa's generated release notes
 * is placed in the most appropriate thematic section.
 *
 * Louisa's prompt mandates grouping by product area (e.g. "Evaluation &
 * Experiment Enhancements", "Trace Visibility & Debugging") rather than
 * by change type ("New Features", "Bug Fixes"). This eval checks that
 * each bullet's content genuinely belongs under the section heading it
 * was placed in.
 *
 * Scoring (per bullet, then aggregated):
 *   1.0 — bullet clearly belongs in its section
 *   0.5 — arguable placement; another section would have been equally valid
 *   0.0 — bullet is in the wrong section; another section fits much better
 *
 * Overall score = mean of per-bullet scores.
 * Final binary: score >= 0.5 → 1, score < 0.5 → 0
 *
 * Uses claude-sonnet-4-6 with extended thinking for the judge so that
 * multi-section comparisons are reasoned through before scoring.
 *
 * Usage:
 *   node scripts/eval-thematic-placement.js
 */

// ─── Env loader ───────────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val) process.env[key] = val;
  }
} catch {
  // rely on env already being set
}

import Anthropic from "@anthropic-ai/sdk";
import { generateReleaseNotes } from "../lib/claude.js";
import { getTracer, forceFlush, activeSpan } from "../lib/otel.js";

// ─── Judge ────────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are an expert evaluator of AI-generated software release notes.

Your task is to assess whether each bullet point in a set of release notes has been
placed under the most appropriate thematic section heading.

## Louisa's section taxonomy

Louisa groups release notes by product area, not by change type. Valid section examples:
  - "Evaluation & Experiment Enhancements"
  - "Trace Visibility & Debugging"
  - "Deployment & Infrastructure Enhancements"
  - "User Experience Improvements"
  - "Security & Access Control"
  - "Integrations & Notifications"
  - "Breaking Changes" (reserved for breaking changes only)

Invalid section patterns (change-type grouping, not product-area grouping):
  - "New Features", "Bug Fixes", "Improvements", "Chores", "Fixes"

## Scoring each bullet

For every bullet point, assign one of:
  1.0 — The bullet unambiguously belongs under this section. Its topic, domain,
         and user impact all align with the section heading.
  0.5 — Placement is defensible but another section would have been equally or
         more appropriate. The content straddles two product areas.
  0.0 — The bullet is clearly misplaced. Its topic belongs in a different named
         section, or the section heading itself violates the taxonomy (change-type
         grouping instead of product-area grouping).

## Output format

Respond ONLY with a JSON object — no markdown, no explanation outside the object:
{
  "bullets": [
    {
      "section": "<exact section heading from the notes>",
      "bullet": "<first 80 chars of bullet text>",
      "score": <1.0 | 0.5 | 0.0>,
      "reason": "<one sentence explaining the score>"
    }
  ],
  "overall": <mean of all bullet scores, rounded to two decimal places>,
  "binary": <1 if overall >= 0.5, else 0>,
  "section_issues": ["<any section heading that violates the product-area taxonomy>"],
  "misplaced": ["<brief description of any bullet that scored 0.0 and where it should go>"]
}`;

function buildJudgePrompt(notes) {
  return `Evaluate the thematic section placement of every bullet point in the following release notes.\n\n${notes}`;
}

async function judge(client, notes) {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
    thinking: {
      type: "enabled",
      budget_tokens: 10000,
    },
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: buildJudgePrompt(notes) }],
  });

  const raw = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return JSON.parse(raw);
}

// ─── Test cases ───────────────────────────────────────────────────────────────

const TEST_CASES = [
  {
    id: "well-placed",
    label: "Well-structured release — all bullets in correct sections",
    tagName: "v3.0.0",
    releaseName: "v3.0.0",
    previousTag: "v2.2.0",
    commits: [
      { sha: "ccc0001", message: "feat: streaming LLM responses in trace viewer", author: "marcus" },
      { sha: "ccc0002", message: "feat: export traces as CSV from Arthur dashboard", author: "priya" },
      { sha: "ccc0003", message: "fix: token counts missing from Claude haiku spans", author: "marcus" },
      { sha: "ccc0004", message: "fix: trace flush timeout on Vercel cold start", author: "priya" },
    ],
    pullRequests: [
      {
        number: 101,
        title: "Streaming LLM traces in real-time viewer",
        author: "marcus",
        labels: ["feature", "observability"],
        body: "The trace viewer now updates in real time as streaming LLM responses arrive.",
      },
      {
        number: 102,
        title: "CSV export for trace data",
        author: "priya",
        labels: ["feature", "data-export"],
        body: "Users can now download any trace list as a CSV file for offline analysis.",
      },
      {
        number: 103,
        title: "Fix missing token counts on Haiku spans",
        author: "marcus",
        labels: ["bug"],
        body: "Fixed by normalising the usage response shape across model families.",
      },
    ],
  },
  {
    id: "mixed-domains",
    label: "Multi-domain release — auth, evals, and infra mixed together",
    tagName: "v4.0.0",
    releaseName: "v4.0.0",
    previousTag: "v3.0.0",
    commits: [
      { sha: "ddd0001", message: "feat: multi-model comparison view in evals dashboard", author: "elena" },
      { sha: "ddd0002", message: "feat: custom eval rubric builder with drag-and-drop", author: "elena" },
      { sha: "ddd0003", message: "feat: SSO login via SAML 2.0", author: "jay" },
      { sha: "ddd0004", message: "feat: role-based access control for eval tasks", author: "jay" },
      { sha: "ddd0005", message: "feat: GitLab MR integration for release notes", author: "ashley" },
      { sha: "ddd0006", message: "feat: Slack release notifications with rich formatting", author: "ashley" },
      { sha: "ddd0007", message: "fix: p95 latency spikes on trace ingestion under load", author: "marcus" },
    ],
    pullRequests: [
      {
        number: 200,
        title: "Multi-model comparison in evals dashboard",
        author: "elena",
        labels: ["feature", "evals"],
        body: "Side-by-side comparison of outputs from up to four models on the same eval dataset.",
      },
      {
        number: 201,
        title: "Drag-and-drop eval rubric builder",
        author: "elena",
        labels: ["feature", "evals", "ux"],
        body: "Replaces the text-box rubric editor with a visual builder.",
      },
      {
        number: 202,
        title: "SAML 2.0 SSO integration",
        author: "jay",
        labels: ["feature", "auth"],
        body: "Enterprise teams can now log in via their existing identity provider using SAML 2.0.",
      },
      {
        number: 203,
        title: "Role-based access control for eval tasks",
        author: "jay",
        labels: ["feature", "auth", "enterprise"],
        body: "Admins can assign Viewer, Editor, or Owner roles per eval task.",
      },
      {
        number: 204,
        title: "GitLab MR integration and Slack release notifications",
        author: "ashley",
        labels: ["feature", "integrations"],
        body: "Louisa now supports GitLab merge requests. Notifications post to Slack with rich blocks.",
      },
      {
        number: 205,
        title: "Fix trace ingestion latency spikes",
        author: "marcus",
        labels: ["bug", "performance"],
        body: "Resolved p95 latency regression under high trace volume.",
      },
    ],
  },
  {
    id: "single-pr",
    label: "Single-PR release — one feature, minimal sections expected",
    tagName: "v2.2.0",
    releaseName: "v2.2.0",
    previousTag: "v2.1.1",
    commits: [
      { sha: "bbb0001", message: "feat: add dark mode support to the evaluation dashboard", author: "ashley" },
      { sha: "bbb0002", message: "fix: dark mode toggle persists across page reloads", author: "ashley" },
    ],
    pullRequests: [
      {
        number: 88,
        title: "Add dark mode to evaluation dashboard",
        author: "ashley",
        labels: ["feature", "ui"],
        body: "Adds a dark/light mode toggle to the evaluation dashboard. Preference stored in localStorage.",
      },
    ],
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runEval(client, tracer, testCase) {
  return activeSpan(tracer, "louisa.eval.thematic_placement", {
    "openinference.span.kind": "CHAIN",
    "agent.name":              "Louisa Eval Runner",
    "eval.id":                 testCase.id,
    "eval.label":              testCase.label,
    "input.value":             JSON.stringify({ tag: testCase.tagName, commits: testCase.commits.length, prs: testCase.pullRequests.length }),
    "input.mime_type":         "application/json",
  }, async (rootSpan) => {

    // Step 1: Generate release notes
    let notes = "";
    await activeSpan(tracer, "louisa.generate_notes", {
      "openinference.span.kind": "TOOL",
      "tool.name":               "generateReleaseNotes",
      "input.value":             JSON.stringify({ tag: testCase.tagName, commitCount: testCase.commits.length, prCount: testCase.pullRequests.length }),
      "input.mime_type":         "application/json",
    }, async (s) => {
      const genResult = await generateReleaseNotes(testCase);
      notes = genResult.text;
      s.setAttribute("output.value",              notes.slice(0, 500) + (notes.length > 500 ? "…" : ""));
      s.setAttribute("output.mime_type",          "text/plain");
      s.setAttribute("llm.token_count.prompt",    genResult.usage.inputTokens);
      s.setAttribute("llm.token_count.completion",genResult.usage.outputTokens);
    });

    // Step 2: Judge thematic placement
    let verdict;
    await activeSpan(tracer, "louisa.eval.judge", {
      "openinference.span.kind": "LLM",
      "llm.model_name":          "claude-sonnet-4-6",
      "tool.description":        "LLM-as-judge: scores thematic section placement of each bullet",
      "input.value":             buildJudgePrompt(notes).slice(0, 800),
      "input.mime_type":         "text/plain",
    }, async (s) => {
      verdict = await judge(client, notes);
      s.setAttribute("output.value",                    JSON.stringify({ overall: verdict.overall, binary: verdict.binary }));
      s.setAttribute("output.mime_type",                "application/json");
      s.setAttribute("eval.overall_score",              verdict.overall);
      s.setAttribute("eval.binary_score",               verdict.binary);
      s.setAttribute("eval.bullet_count",               verdict.bullets.length);
      s.setAttribute("eval.misplaced_count",            verdict.misplaced.length);
      s.setAttribute("eval.section_issues_count",       verdict.section_issues.length);
    });

    rootSpan.setAttribute("eval.overall_score", verdict.overall);
    rootSpan.setAttribute("eval.binary_score",  verdict.binary);
    rootSpan.setAttribute("eval.pass",          String(verdict.binary === 1));
    rootSpan.setAttribute("output.value",       JSON.stringify({ binary: verdict.binary, overall: verdict.overall }));
    rootSpan.setAttribute("output.mime_type",   "application/json");

    return { testCase, notes, verdict };
  });
}

// ─── Output ───────────────────────────────────────────────────────────────────

function printResult({ testCase, notes, verdict }) {
  const pass = verdict.binary === 1;
  const icon = pass ? "✅" : "❌";

  console.log(`\n${icon}  [${testCase.id}] ${testCase.label}`);
  console.log(`   Score: ${(verdict.overall * 100).toFixed(0)}/100  →  binary: ${verdict.binary}  (${verdict.bullets.length} bullets evaluated)`);

  if (verdict.section_issues.length > 0) {
    console.log("   Section taxonomy violations:");
    verdict.section_issues.forEach(i => console.log(`     • ${i}`));
  }

  if (verdict.misplaced.length > 0) {
    console.log("   Misplaced bullets:");
    verdict.misplaced.forEach(m => console.log(`     • ${m}`));
  }

  const low = verdict.bullets.filter(b => b.score < 1.0);
  if (low.length > 0) {
    console.log("   Bullets scoring < 1.0:");
    low.forEach(b => console.log(`     [${b.score}] "${b.bullet.slice(0, 70)}…"\n            → ${b.reason}`));
  }

  const preview = notes.slice(0, 200).replace(/\n/g, " ").trimEnd();
  console.log(`   Output preview: "${preview}${notes.length > 200 ? "…" : ""}"`);
}

function printSummary(results) {
  const pass  = results.filter(r => r.verdict.binary === 1).length;
  const total = results.length;
  const avg   = results.reduce((s, r) => s + r.verdict.overall, 0) / total;

  console.log("\n" + "─".repeat(72));
  console.log(`SUMMARY  ${pass}/${total} passed  |  avg score: ${(avg * 100).toFixed(0)}/100`);

  if (pass < total) {
    console.log("\nFailed cases:");
    results.filter(r => r.verdict.binary !== 1).forEach(r =>
      console.log(`  ✗  ${r.testCase.id}  (${(r.verdict.overall * 100).toFixed(0)}/100)`)
    );
  }
  console.log("─".repeat(72));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const tracer  = getTracer();

  console.log("Louisa · Thematic Section Placement Eval");
  console.log("Testing that each bullet appears in the correct product-area section");
  console.log("─".repeat(72));
  console.log(`Running ${TEST_CASES.length} test cases…\n`);

  const results = [];
  for (const tc of TEST_CASES) {
    process.stdout.write(`  Running "${tc.id}"…`);
    try {
      const r = await runEval(client, tracer, tc);
      results.push(r);
      process.stdout.write(` ${r.verdict.binary === 1 ? "PASS" : "FAIL"}  (${(r.verdict.overall * 100).toFixed(0)}/100)\n`);
    } catch (err) {
      process.stdout.write(` ERROR: ${err.message}\n`);
    }
  }

  results.forEach(printResult);
  printSummary(results);

  console.log("\nFlushing eval traces to Arthur Engine…");
  await forceFlush();
  console.log("Done.");
}

main().catch(err => {
  console.error("Eval failed:", err);
  process.exit(1);
});
