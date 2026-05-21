// metrics.js — Prometheus instrumentation for PulseAPI
//
// All metric objects are singletons exported from this module.
// index.js imports them to record observations; the /metrics endpoint
// calls register.metrics() to serialize the current state for Prometheus.
//
// Metric naming follows the Prometheus convention:
//   <namespace>_<subsystem>_<name>_<unit>
// namespace = pulseapi

'use strict';

const client = require('prom-client');

// Collect default Node.js metrics (event loop lag, GC, heap, file descriptors)
// These show up in Grafana as process_* and nodejs_* series automatically.
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'pulseapi_' });

// ── HTTP request throughput ───────────────────────────────────────────────
// Counter — monotonically increasing; Prometheus rate() gives req/s
const httpRequestsTotal = new client.Counter({
  name: 'pulseapi_http_requests_total',
  help: 'Total number of HTTP requests proxied through the gateway',
  labelNames: ['method', 'route_id', 'status_code'],
  registers: [register],
});

// ── Request latency distribution ──────────────────────────────────────────
// Histogram — enables p50/p95/p99 in Prometheus via histogram_quantile()
// Buckets tuned for an API gateway: most requests <100ms, tail up to 10s
const httpRequestDurationMs = new client.Histogram({
  name: 'pulseapi_http_request_duration_ms',
  help: 'HTTP request latency in milliseconds',
  labelNames: ['method', 'route_id', 'status_code'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});

// ── Upstream proxy errors ─────────────────────────────────────────────────
const upstreamErrorsTotal = new client.Counter({
  name: 'pulseapi_upstream_errors_total',
  help: 'Number of upstream errors (5xx responses or connection failures)',
  labelNames: ['upstream', 'route_id', 'error_type'], // error_type: timeout | 5xx | circuit_open
  registers: [register],
});

// ── Rate limit rejections ─────────────────────────────────────────────────
const rateLimitRejectionsTotal = new client.Counter({
  name: 'pulseapi_rate_limit_rejections_total',
  help: 'Number of requests rejected by the rate limiter (HTTP 429)',
  labelNames: ['route_id', 'algorithm'], // algorithm: token-bucket | sliding-window
  registers: [register],
});

// ── Circuit breaker state ─────────────────────────────────────────────────
// Gauge — current state: 0=closed (healthy), 1=half_open, 2=open (tripped)
// Graphing this over time makes circuit trips visible instantly in Grafana
const circuitBreakerState = new client.Gauge({
  name: 'pulseapi_circuit_breaker_state',
  help: 'Circuit breaker state per upstream: 0=closed 1=half_open 2=open',
  labelNames: ['upstream'],
  registers: [register],
});

// ── Retry attempts ────────────────────────────────────────────────────────
const proxyRetriesTotal = new client.Counter({
  name: 'pulseapi_proxy_retries_total',
  help: 'Number of upstream retry attempts made by the gateway',
  labelNames: ['route_id', 'upstream'],
  registers: [register],
});

// ── Active WebSocket connections ──────────────────────────────────────────
const wsConnectionsActive = new client.Gauge({
  name: 'pulseapi_ws_connections_active',
  help: 'Number of active dashboard WebSocket connections',
  registers: [register],
});

// ── Active routes ─────────────────────────────────────────────────────────
const routesActive = new client.Gauge({
  name: 'pulseapi_routes_active',
  help: 'Number of routes currently loaded in the gateway',
  registers: [register],
});

// Helper: map circuit breaker string state → numeric gauge value
const CB_STATE_VALUE = { closed: 0, half_open: 1, open: 2 };

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDurationMs,
  upstreamErrorsTotal,
  rateLimitRejectionsTotal,
  circuitBreakerState,
  proxyRetriesTotal,
  wsConnectionsActive,
  routesActive,
  CB_STATE_VALUE,
};
