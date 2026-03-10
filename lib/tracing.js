/**
 * Zero-dependency OpenInference-compatible OTLP tracing for Arthur Engine.
 *
 * Sends spans to {ARTHUR_BASE_URL}/api/v1/traces using OTLP HTTP protobuf format.
 * Silently skips if env vars are missing or the request fails.
 *
 * OpenInference span kinds:
 *   CHAIN  — top-level pipeline / orchestration
 *   LLM    — Claude API calls
 *   TOOL   — individual API/service calls
 */

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Protobuf encoding helpers
// ---------------------------------------------------------------------------

function encodeVarint(n) {
  n = BigInt(n);
  const bytes = [];
  while (n > 127n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

// Length-delimited field (wire type 2)
function lenField(field, data) {
  return Buffer.concat([encodeVarint((BigInt(field) << 3n) | 2n), encodeVarint(data.length), data]);
}
// String field (length-delimited)
function strField(field, str) {
  if (!str && str !== "0") return Buffer.alloc(0);
  return lenField(field, Buffer.from(str, "utf8"));
}
// Bytes field (length-delimited, input is hex string)
function bytesField(field, hex) {
  return lenField(field, Buffer.from(hex, "hex"));
}
// Fixed64 field (wire type 1) — for nanosecond timestamps
function fixed64Field(field, nano) {
  let n = BigInt(nano);
  const buf = Buffer.allocUnsafe(8);
  for (let i = 0; i < 8; i++) { buf[i] = Number(n & 0xffn); n >>= 8n; }
  return Buffer.concat([Buffer.from([(field << 3) | 1]), buf]);
}
// Varint field (wire type 0) — for enums/ints
function varintField(field, value) {
  return Buffer.concat([encodeVarint((BigInt(field) << 3n) | 0n), encodeVarint(value)]);
}

// AnyValue oneof: string_value=1, bool_value=2, int_value=3
function anyValue(value) {
  if (typeof value === "boolean") return varintField(2, value ? 1 : 0);
  if (typeof value === "number" && Number.isInteger(value)) return varintField(3, value);
  return strField(1, String(value ?? ""));
}

// KeyValue { key=1, value=2 }
function keyValue(key, value) {
  return Buffer.concat([strField(1, key), lenField(2, anyValue(value))]);
}

// Encode a repeated attributes field (fieldNum) from an array of [key, value] pairs
function attrsFields(fieldNum, pairs) {
  return Buffer.concat(pairs.map(([k, v]) => lenField(fieldNum, keyValue(k, v))));
}

// Normalize attribute value from OTLP JSON attr shape or raw value
function attrVal(a) {
  if (a.value !== undefined) {
    const v = a.value;
    return v.stringValue ?? v.boolValue ?? v.intValue ?? String(v);
  }
  return a;
}

// Status { message=2, code=3 } embedded at Span field 15
function statusMsg(code, message) {
  const parts = [];
  if (message) parts.push(strField(2, message));
  parts.push(varintField(3, code));
  return lenField(15, Buffer.concat(parts));
}

// Encode a Span message
function encodeSpan(s) {
  const attrs = (s.attributes || []).map(a => [a.key, attrVal(a)]);
  return Buffer.concat([
    bytesField(1, s.traceId),
    bytesField(2, s.spanId),
    ...(s.parentSpanId ? [bytesField(4, s.parentSpanId)] : []),
    strField(5, s.name),
    varintField(6, s.kind ?? 1),
    fixed64Field(7, s.startTimeUnixNano),
    fixed64Field(8, s.endTimeUnixNano),
    attrsFields(9, attrs),
    statusMsg(s.status?.code ?? 1, s.status?.message),
  ]);
}

// ScopeSpans { scope=1, spans=2 }
function encodeScopeSpans(ss) {
  const scopeParts = [];
  if (ss.scope?.name) scopeParts.push(strField(1, ss.scope.name));
  if (ss.scope?.version) scopeParts.push(strField(2, ss.scope.version));
  return Buffer.concat([
    ...(scopeParts.length ? [lenField(1, Buffer.concat(scopeParts))] : []),
    ...(ss.spans || []).map(sp => lenField(2, encodeSpan(sp))),
  ]);
}

// ResourceSpans { resource=1, scope_spans=2 }
function encodeResourceSpans(rs) {
  const resAttrs = (rs.resource?.attributes || []).map(a => [a.key, attrVal(a)]);
  const resBytes = attrsFields(1, resAttrs);
  return Buffer.concat([
    ...(resBytes.length ? [lenField(1, resBytes)] : []),
    ...(rs.scopeSpans || []).map(ss => lenField(2, encodeScopeSpans(ss))),
  ]);
}

// ExportTraceServiceRequest { resource_spans=1 }
function encodeTraceRequest(req) {
  return Buffer.concat((req.resourceSpans || []).map(rs => lenField(1, encodeResourceSpans(rs))));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function nowNano() {
  return (BigInt(Date.now()) * 1_000_000n).toString();
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
  const traceId = randomBytes(16).toString("hex");
  const spans = [];

  function span(name, parentSpanId, attrPairs = []) {
    const spanId = randomBytes(8).toString("hex");
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
      attributes: attrPairs.map(([k, v]) => ({ key: k, value: { stringValue: String(v ?? "") } })),
      status: { code: 1 },
    };

    return {
      spanId,
      addAttr(key, value) {
        s.attributes.push({ key, value: { stringValue: String(value ?? "") } });
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
      { key: "service.name", value: { stringValue: "louisa" } },
      { key: "service.version", value: { stringValue: "1.0.0" } },
    ];
    if (taskId) {
      // session.id is the OpenInference convention for linking to an agentic task
      resourceAttrs.push({ key: "session.id", value: { stringValue: taskId } });
      resourceAttrs.push({ key: "arthur.task_id", value: { stringValue: taskId } });
    }

    const body = encodeTraceRequest({
      resourceSpans: [{
        resource: { attributes: resourceAttrs },
        scopeSpans: [{ scope: { name: "louisa", version: "1.0.0" }, spans }],
      }],
    });

    try {
      const url = `${baseUrl.replace(/\/$/, "")}/api/v1/traces`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-protobuf",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        console.log(`Louisa: Arthur trace sent — ${data.accepted_spans ?? spans.length} spans accepted, traceId=${traceId}`);
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
