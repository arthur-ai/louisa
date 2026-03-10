/**
 * Zero-dependency OpenInference-compatible OTLP tracing for Arthur Engine.
 *
 * Sends spans to {ARTHUR_BASE_URL}/v1/traces using OTLP HTTP JSON format.
 * Silently skips if env vars are missing or the request fails.
 *
 * OpenInference span kinds:
 *   CHAIN  — top-level pipeline / orchestration
 *   LLM    — Claude API calls
 *   TOOL   — individual API/service calls
 */

import { randomBytes } from "node:crypto";

function hex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function nowNano() {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function toAttr(key, value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return { key, value: { intValue: value } };
  }
  if (typeof value === "boolean") {
    return { key, value: { boolValue: value } };
  }
  return { key, value: { stringValue: String(value ?? "") } };
}

/**
 * Create a new trace context.
 *
 * const trace = createTrace();
 * const root = trace.span("op.name", null, [["openinference.span.kind", "CHAIN"]]);
 * root.addAttr("tag", "v1.2.3");
 * root.end();
 * await trace.send();
 */
export function createTrace() {
  const traceId = hex(16);
  const spans = [];

  function span(name, parentSpanId, attrPairs = []) {
    const spanId = hex(8);
    const startTimeUnixNano = nowNano();
    let ended = false;

    const s = {
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name,
      kind: 1, // INTERNAL
      startTimeUnixNano,
      endTimeUnixNano: startTimeUnixNano,
      attributes: attrPairs.map(([k, v]) => toAttr(k, v)),
      status: { code: 1 }, // OK
    };

    return {
      spanId,
      addAttr(key, value) {
        s.attributes.push(toAttr(key, value));
        return this;
      },
      end(error) {
        if (ended) return;
        ended = true;
        s.endTimeUnixNano = nowNano();
        if (error) {
          s.status = { code: 2, message: error.message || String(error) };
        }
        spans.push(s);
      },
    };
  }

  async function send() {
    const baseUrl = process.env.ARTHUR_BASE_URL;
    const apiKey = process.env.ARTHUR_API_KEY;
    const taskId = process.env.ARTHUR_TASK_ID;

    if (!baseUrl || !apiKey) {
      console.warn("Louisa: Arthur tracing not configured, skipping");
      return;
    }

    if (spans.length === 0) return;

    const resourceAttrs = [
      toAttr("service.name", "louisa"),
      toAttr("service.version", "1.0.0"),
    ];
    if (taskId) {
      // session.id is the OpenInference convention for linking to an agentic task
      resourceAttrs.push(toAttr("session.id", taskId));
      resourceAttrs.push(toAttr("arthur.task_id", taskId));
    }

    const body = {
      resourceSpans: [
        {
          resource: { attributes: resourceAttrs },
          scopeSpans: [
            {
              scope: { name: "louisa", version: "1.0.0" },
              spans,
            },
          ],
        },
      ],
    };

    try {
      const url = `${baseUrl.replace(/\/$/, "")}/v1/traces`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        console.log(`Louisa: Arthur trace sent — ${spans.length} spans, traceId=${traceId}`);
      } else {
        const text = await res.text().catch(() => "");
        console.warn(`Louisa: Arthur trace failed ${res.status} — ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`Louisa: Arthur trace send error — ${err.message}`);
    }
  }

  return { traceId, span, send };
}

/**
 * Run an async function wrapped in a child span.
 * The callback receives the span handle to add output attributes before it ends.
 *
 * const result = await traced(trace, "github.get_commits", [
 *   ["openinference.span.kind", "TOOL"],
 *   ["tool.name", "github.getCommitsBetweenTags"],
 *   ["input.value", JSON.stringify({ owner, repo })],
 * ], parentSpanId, async (s) => {
 *   const commits = await getCommitsBetweenTags(...);
 *   s.addAttr("output.value", `${commits.length} commits`);
 *   return commits;
 * });
 */
export async function traced(trace, name, attrPairs, parentSpanId, fn) {
  const s = trace.span(name, parentSpanId, attrPairs);
  try {
    const result = await fn(s);
    s.end();
    return result;
  } catch (err) {
    s.end(err);
    throw err;
  }
}
