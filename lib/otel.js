/**
 * OpenTelemetry + OpenInference instrumentation for Louisa.
 *
 * Initialised lazily once per serverless container lifetime.
 * Sends OTLP/proto spans to Arthur Engine at ARTHUR_BASE_URL/api/v1/traces.
 * Auto-instruments the Anthropic SDK via AnthropicInstrumentation so every
 * messages.create() call produces a correctly-attributed LLM span.
 *
 * Usage:
 *   import { getTracer, forceFlush, activeSpan } from "../lib/otel.js";
 *
 *   const tracer = getTracer();
 *   const result = await activeSpan(tracer, "my.operation", { "openinference.span.kind": "TOOL", ... }, async (span) => {
 *     const out = await doWork();
 *     span.setAttribute("output.value", out);
 *     return out;
 *   });
 *   await forceFlush();
 */

import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import resourcesPkg from "@opentelemetry/resources";
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic";
import Anthropic from "@anthropic-ai/sdk";

const { resourceFromAttributes } = resourcesPkg;

let _initialized = false;
let _provider = null;

function ensureProvider() {
  if (_initialized) return _provider;
  _initialized = true;

  const baseUrl = process.env.ARTHUR_BASE_URL?.replace(/\/$/, "");
  const apiKey  = process.env.ARTHUR_API_KEY;
  const taskId  = process.env.ARTHUR_TASK_ID;

  if (!baseUrl || !apiKey) {
    console.warn("Louisa: Arthur tracing not configured (ARTHUR_BASE_URL / ARTHUR_API_KEY missing), skipping");
    return null;
  }

  const resourceAttrs = {
    "service.name": "louisa",
    "service.version": "1.0.0",
  };
  if (taskId) {
    // session.id is the OpenInference convention for linking spans to an agentic task
    resourceAttrs["session.id"]       = taskId;
    resourceAttrs["arthur.task_id"]   = taskId;
  }

  const exporter = new OTLPTraceExporter({
    url: `${baseUrl}/api/v1/traces`,
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  _provider = new NodeTracerProvider({
    resource: resourceFromAttributes(resourceAttrs),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  // Patch the Anthropic SDK class so every messages.create() call is
  // automatically wrapped in an OpenInference LLM span. Must be called
  // before provider.register() so the instrumentation has a provider to use.
  const instrumentation = new AnthropicInstrumentation();
  instrumentation.manuallyInstrument(Anthropic);

  _provider.register(); // sets as global OTel tracer provider
  console.log("Louisa: OTel + OpenInference tracing initialised");
  return _provider;
}

/**
 * Returns the named OTel tracer, initialising the provider on first call.
 */
export function getTracer() {
  ensureProvider();
  return trace.getTracer("louisa", "1.0.0");
}

/**
 * Force-flush all pending spans to the exporter.
 * Must be called before returning from a serverless handler to avoid losing spans.
 */
export async function forceFlush() {
  if (_provider) {
    await _provider.forceFlush().catch((e) =>
      console.warn("Louisa: trace flush error —", e.message)
    );
  }
}

/**
 * Run `fn` inside a new active OTel span, automatically ending it on success
 * or error and propagating context so nested spans (including Anthropic SDK
 * auto-instrumented LLM spans) are correctly parented.
 *
 * @template T
 * @param {import("@opentelemetry/api").Tracer} tracer
 * @param {string} name
 * @param {Record<string, string|number|boolean>} attrs - initial span attributes
 * @param {(span: import("@opentelemetry/api").Span) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function activeSpan(tracer, name, attrs, fn) {
  return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes: attrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      span.end();
      throw err;
    }
  });
}

export { SpanKind, SpanStatusCode };
