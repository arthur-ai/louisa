/**
 * Eval: User-Facing Impact Classification
 *
 * Evaluates whether each bullet point in Louisa's generated release notes
 * describes a change that meaningfully impacts the end-user experience.
 *
 * Release notes are aimed at external users, developers, and stakeholders.
 * This eval checks that internal infrastructure, deployment, and operational
 * changes (e.g. OIDC configuration, CI pipeline updates, dependency bumps)
 * are not included — only changes that add value to or visibly affect the
 * end-user experience should appear.
 *
 * Scoring (per bullet, then aggregated):
 *   1.0 — bullet clearly describes a user-facing change
 *   0.5 — bullet describes a change with indirect or arguable user impact
 *   0.0 — bullet describes an internal/infrastructure change with no user impact
 *
 * Overall score = mean of per-bullet scores.
 * Final binary: score >= 0.5 → 1, score < 0.5 → 0
 *
 * Usage:
 *   node scripts/eval-user-facing-impact.js
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

Your task is to assess whether each bullet point in a set of release notes describes a change that meaningfully impacts the end-user experience and belongs in external-facing release notes.

## What counts as user-facing

A bullet is user-facing if it describes something an external user, developer, or stakeholder would directly notice, benefit from, or care about. Examples:

- New features, capabilities, or UI changes a user can interact with
- Bug fixes that correct visible or functional behaviour the user experienced
- Performance improvements a user would perceive (e.g. faster load times, lower latency)
- Security changes that affect how users authenticate or what they can access
- API or SDK changes that affect how developers integrate with the product

## What does NOT belong in external release notes

A bullet should be excluded if it describes an internal or operational change that has no direct effect on the end-user experience. Examples:

- Deployment pipeline changes (e.g. OIDC configuration, CI/CD workflow updates)
- Infrastructure provisioning or cloud configuration changes
- Internal dependency version bumps with no user-visible effect
- Refactors or code quality improvements with no functional change
- Monitoring, alerting, or observability tooling changes
- Internal authentication mechanism changes (e.g. switching OIDC providers internally)

## Scoring each bullet

For every bullet point, assign one of:
  1.0 — The bullet clearly describes a user-facing change. An external user or developer would directly notice or benefit from it.
  0.5 — The bullet describes a change with indirect or arguable user impact. It might matter to some users but is borderline.
  0.0 — The bullet describes an internal, infrastructure, or deployment-only change. An external user would not notice or benefit from it and it should have been excluded.

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
  "excluded": ["<brief description of any bullet scoring 0.0 that should have been omitted>"],
  "borderline": ["<brief description of any bullet scoring 0.5>"]
}`;

function buildJudgePrompt(notes) {
  return `Evaluate the user-facing impact of every bullet point in the following release notes.\n\n${notes}`;
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
    id: "clean-user-facing",
    label: "Release containing only genuine user-facing changes",
    tagName: "v3.1.0",
    releaseName: "v3.1.0",
    previousTag: "v3.0.0",
    commits: [
      { sha: "aaa0001", message: "feat: add dark mode toggle to evaluation dashboard", author: "ashley" },
      { sha: "aaa0002", message: "feat: side-by-side multi-model comparison view", author: "elena" },
      { sha: "aaa0003", message: "feat: export trace list as CSV", author: "priya" },
      { sha: "aaa0004", message: "fix: eval scores now persist after browser refresh", author: "priya" },
    ],
    pullRequests: [
      {
        number: 110,
        title: "Dark mode for evaluation dashboard",
        author: "ashley",
        labels: ["feature", "ui"],
        body: "Adds a dark/light mode toggle. Preference stored in localStorage and follows system preference on first load.",
      },
      {
        number: 111,
        title: "Multi-model comparison view",
        author: "elena",
        labels: ["feature", "evals"],
        body: "Side-by-side comparison of outputs from up to four models on the same eval dataset with a heatmap of scores.",
      },
      {
        number: 112,
        title: "CSV export for trace data",
        author: "priya",
        labels: ["feature", "data-export"],
        body: "Users can download any trace list as a CSV file for offline analysis or import into BI tools.",
      },
      {
        number: 113,
        title: "Fix eval scores not persisting after refresh",
        author: "priya",
        labels: ["bug"],
        body: "Scores were being dropped from local state on page reload due to a missing serialisation step.",
      },
    ],
  },
  {
    id: "mixed-with-infra",
    label: "Release mixing user-facing changes with internal infrastructure changes",
    tagName: "v3.2.0",
    releaseName: "v3.2.0",
    previousTag: "v3.1.0",
    commits: [
      { sha: "bbb0001", message: "feat: streaming LLM responses in trace viewer", author: "marcus" },
      { sha: "bbb0002", message: "fix: token counts missing from Claude haiku spans", author: "marcus" },
      { sha: "bbb0003", message: "chore: migrate OIDC provider from Auth0 to Okta internally", author: "jay" },
      { sha: "bbb0004", message: "ci: update GitHub Actions runner to ubuntu-24.04", author: "ci-bot" },
      { sha: "bbb0005", message: "chore: bump OTel exporter to 0.214.0", author: "renovate[bot]" },
    ],
    pullRequests: [
      {
        number: 120,
        title: "Streaming LLM traces in real-time viewer",
        author: "marcus",
        labels: ["feature", "observability"],
        body: "The trace viewer now updates in real time as streaming LLM responses arrive. Tokens appear as they are generated.",
      },
      {
        number: 121,
        title: "Fix missing token counts on Haiku spans",
        author: "marcus",
        labels: ["bug"],
        body: "Token usage was not being captured for claude-haiku-4-5 calls. Fixed by normalising the usage response shape.",
      },
      {
        number: 122,
        title: "Migrate internal OIDC provider to Okta",
        author: "jay",
        labels: ["infrastructure", "auth"],
        body: "Internal OIDC configuration updated to use Okta as the identity provider. No change to user-facing login flows.",
      },
    ],
  },
  {
    id: "infra-only",
    label: "Release containing only infrastructure and deployment changes",
    tagName: "v3.2.1",
    releaseName: "v3.2.1",
    previousTag: "v3.2.0",
    commits: [
      { sha: "ccc0001", message: "chore: bump @anthropic-ai/sdk to 0.78.1", author: "renovate[bot]" },
      { sha: "ccc0002", message: "ci: update GitHub Actions runner to ubuntu-24.04", author: "ci-bot" },
      { sha: "ccc0003", message: "chore: migrate OIDC deployment configuration for AWS prod", author: "jay" },
      { sha: "ccc0004", message: "chore: update OTel collector sidecar resource limits", author: "marcus" },
    ],
    pullRequests: [
      {
        number: 130,
        title: "Bump Anthropic SDK and CI runner",
        author: "renovate[bot]",
        labels: ["chore"],
        body: "Routine dependency update. No functional changes.",
      },
      {
        number: 131,
        title: "OIDC deployment config update for AWS prod",
        author: "jay",
        labels: ["infrastructure"],
        body: "Updates OIDC trust policy for the AWS production environment. Internal deployment change only.",
      },
    ],
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runEval(client, tracer, testCase) {
  return activeSpan(tracer, "louisa.eval.user_facing_impact", {
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
      s.setAttribute("output.value",               notes.slice(0, 500) + (notes.length > 500 ? "…" : ""));
      s.setAttribute("output.mime_type",           "text/plain");
      s.setAttribute("llm.token_count.prompt",     genResult.usage.inputTokens);
      s.setAttribute("llm.token_count.completion", genResult.usage.outputTokens);
    });

    // Step 2: Judge user-facing impact
    let verdict;
    await activeSpan(tracer, "louisa.eval.judge", {
      "openinference.span.kind": "LLM",
      "llm.model_name":          "claude-sonnet-4-6",
      "tool.description":        "LLM-as-judge: classifies each bullet as user-facing or internal-only",
      "input.value":             buildJudgePrompt(notes).slice(0, 800),
      "input.mime_type":         "text/plain",
    }, async (s) => {
      verdict = await judge(client, notes);
      s.setAttribute("output.value",              JSON.stringify({ overall: verdict.overall, binary: verdict.binary }));
      s.setAttribute("output.mime_type",          "application/json");
      s.setAttribute("eval.overall_score",        verdict.overall);
      s.setAttribute("eval.binary_score",         verdict.binary);
      s.setAttribute("eval.bullet_count",         verdict.bullets.length);
      s.setAttribute("eval.excluded_count",       verdict.excluded.length);
      s.setAttribute("eval.borderline_count",     verdict.borderline.length);
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

  if (verdict.excluded.length > 0) {
    console.log("   Should have been excluded (scored 0.0):");
    verdict.excluded.forEach(e => console.log(`     • ${e}`));
  }

  if (verdict.borderline.length > 0) {
    console.log("   Borderline (scored 0.5):");
    verdict.borderline.forEach(b => console.log(`     • ${b}`));
  }

  const low = verdict.bullets.filter(b => b.score < 1.0);
  if (low.length > 0) {
    console.log("   Bullets scoring < 1.0:");
    low.forEach(b => console.log(`     [${b.score}] "${b.bullet.slice(0, 70)}"\n            → ${b.reason}`));
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

  console.log("Louisa · User-Facing Impact Classification Eval");
  console.log("Testing that release notes contain only end-user-relevant changes");
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
