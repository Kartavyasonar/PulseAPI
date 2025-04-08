// OpenTelemetry distributed tracing — must be required FIRST in index.js
// before any other imports so auto-instrumentation can patch http/express

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { trace, context } = require('@opentelemetry/api');

const exporter = new JaegerExporter({
  endpoint: process.env.JAEGER_ENDPOINT || 'http://jaeger:14268/api/traces',
});

const sdk = new NodeSDK({
  traceExporter: exporter,
  serviceName: 'pulseapi-gateway',
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false }, // too noisy
    }),
  ],
});

sdk.start();
console.log('[tracing] OpenTelemetry initialized -> Jaeger');

process.on('SIGTERM', () => sdk.shutdown().catch(console.error));

// helper: get current trace ID for logging
function getCurrentTraceId() {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  return ctx.traceId || null;
}

module.exports = { getCurrentTraceId };
