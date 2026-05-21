# ⚡ PulseAPI — Production-Grade API Gateway

A fully functional API gateway built from scratch. Proxies requests, enforces rate limiting via token bucket or sliding window algorithms, handles JWT auth, circuit breaking, retry with exponential backoff, multi-tenancy, distributed tracing, Prometheus metrics, a live analytics dashboard, and **Kafka-based async request logging** for durable, decoupled observability.

## Quick Start

```bash
docker compose up -d --build
# wait ~30s for DB init
curl http://localhost:3000/health
```

**Services after startup:**

| Service | URL |
|---------|-----|
| Gateway | http://localhost:3000 |
| Dashboard | http://localhost:5173 |
| Grafana | http://localhost:3001 (admin / pulse) |
| Prometheus | http://localhost:9090 |
| Jaeger UI | http://localhost:16686 |
| Kafka broker | localhost:9092 |
| Admin API | http://localhost:3000/admin (X-Api-Key: admin-secret-key) |


---

## Architecture

```
Client → PulseAPI Gateway (Node.js/Express)
              │
              ├── Token Bucket Rate Limiter ──┐
              ├── Sliding Window Rate Limiter ─┤→ Redis
              ├── Circuit Breaker state ───────┘
              ├── JWT Auth Middleware
              ├── Round-Robin Load Balancer
              ├── Retry + Exponential Backoff
              │
              ├── upstream-1 (5% fail rate)
              ├── upstream-2 (2% fail rate)
              └── upstream-3 (stable)

Kafka topic ← Request events (async publish, off critical path)
  └── kafka-consumer → PostgreSQL (batch INSERT, 500 records or 1s)

WebSocket  → Dashboard (live stats, 1s push)
Jaeger     ← Distributed traces (OTel)
Prometheus ← /metrics scraped every 15s
Grafana    → 13-panel dashboard (auto-provisioned)
```

### Kafka async logging pipeline

Request logs are published to a Kafka topic (`request-logs`) instead of writing directly to Postgres. A separate `kafka-consumer` service subscribes and batch-inserts to Postgres.

**Why async via Kafka vs. direct write?**
- Gateway latency is fully decoupled from Postgres write throughput
- Kafka retains messages during DB maintenance windows — no logs dropped
- Fan-out: add analytics consumers, SIEM feeds without touching the gateway
- Consumer lag is a Kafka-native observable metric
- Historical replay: reprocess logs against a new schema without rerunning load tests

The gateway falls back to direct Postgres writes automatically when `KAFKA_BROKERS` is not set — local dev works without a Kafka cluster.

---

## Observability

### Prometheus + Grafana

`/metrics` is exposed via `prom-client` and scraped by Prometheus every 15 seconds. The Grafana dashboard provisions automatically on first boot — no manual setup required.

**Metrics exposed:**

| Metric | Type | Description |
|--------|------|-------------|
| `pulseapi_http_requests_total` | Counter | Request count by method, route, status code |
| `pulseapi_http_request_duration_ms` | Histogram | Latency distribution (p50/p95/p99 via `histogram_quantile`) |
| `pulseapi_upstream_errors_total` | Counter | Upstream failures by type (5xx, timeout, circuit_open) |
| `pulseapi_rate_limit_rejections_total` | Counter | 429s by route and algorithm |
| `pulseapi_circuit_breaker_state` | Gauge | Per-upstream state: 0=closed, 1=half_open, 2=open |
| `pulseapi_proxy_retries_total` | Counter | Retry attempts by route and upstream |
| `pulseapi_ws_connections_active` | Gauge | Active dashboard WebSocket connections |
| `pulseapi_routes_active` | Gauge | Routes currently loaded in the gateway |

**Key PromQL queries:**

```promql
# p99 latency
histogram_quantile(0.99, sum(rate(pulseapi_http_request_duration_ms_bucket[5m])) by (le))

# error rate %
100 * sum(rate(pulseapi_http_requests_total{status_code=~"5.."}[1m])) / sum(rate(pulseapi_http_requests_total[1m]))

# live request rate by route
sum(rate(pulseapi_http_requests_total[1m])) by (route_id)
```

### Distributed Tracing — OpenTelemetry + Jaeger

Every request gets a trace ID propagated through gateway to upstream. Trace ID stored in `requests.trace_id` for cross-signal correlation.

```sql
SELECT * FROM requests WHERE trace_id = 'abc123...';
```

View traces at **http://localhost:16686**

---

## Load Testing

```bash
# install k6
k6 run load-tests/k6.js
```

**Measured results at 200 VUs:**

| Metric | Value |
|--------|-------|
| Sustained throughput | 207 req/s |
| p50 latency | 282ms |
| p95 latency | 407ms |
| p99 latency | 881ms (via `histogram_quantile` in Prometheus) |
| Error rate | 0.0% (enterprise tenant, 1000 req/s quota) |

---

## Features

### Rate Limiting — Token Bucket & Sliding Window

Implemented in `gateway/src/plugins/rateLimit.js` using Redis Lua scripts for atomicity — no race conditions under concurrent load.

```bash
# trigger rate limiting (10 req/s default limit)
for i in {1..20}; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/upstream1/test; done
```

### Circuit Breaker — CLOSED / OPEN / HALF_OPEN

State stored in Redis, shared across all gateway instances. Opens after 5 consecutive 5xx failures, auto-recovers after 30s via HALF_OPEN probe.

```bash
# check all circuit states
curl -H "X-Api-Key: admin-secret-key" http://localhost:3000/admin/circuit-breakers

# manually reset a circuit
curl -X POST http://localhost:3000/admin/circuit-breakers/reset \
  -H "X-Api-Key: admin-secret-key" -H "Content-Type: application/json" \
  -d '{"upstream":"http://upstream1:4001"}'
```

### Hot Route Reload — Zero Downtime

```bash
curl -X POST http://localhost:3000/admin/routes \
  -H "X-Api-Key: admin-secret-key" -H "Content-Type: application/json" \
  -d '{
    "id": "my-service",
    "pathPrefix": "/my-service",
    "upstreams": [{"url": "http://my-backend:8080", "weight": 1}],
    "plugins": {
      "rateLimit": {"enabled": true, "requestsPerSecond": 100, "algorithm": "token-bucket"},
      "auth": {"enabled": false}
    }
  }'
# route is live immediately — no restart needed
```

### JWT Auth

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/admin/token \
  -H "X-Api-Key: admin-secret-key" | jq -r .token)

curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/secure/data
```

---

## Multi-Tenant Quota Management

Tenant API keys stored as SHA-256 hashes — raw keys never persisted.

| Tier | Rate Limit | Burst |
|------|-----------|-------|
| Free | 10 req/s | 20 |
| Pro | 100 req/s | 200 |
| Enterprise | 1000 req/s | 2000 |

```bash
# create tenant
curl -X POST http://localhost:3000/admin/tenants \
  -H "X-Api-Key: admin-secret-key" -H "Content-Type: application/json" \
  -d '{"id":"acme","name":"Acme Corp","tier":"pro"}'

# generate API key (shown once, hash stored)
curl -X POST http://localhost:3000/admin/tenants/acme/keys \
  -H "X-Api-Key: admin-secret-key"

# view usage
curl -H "X-Api-Key: admin-secret-key" http://localhost:3000/admin/tenants/acme/usage
```

---

## Analytics — p50/p95/p99 from PostgreSQL

```bash
curl -H "X-Api-Key: admin-secret-key" \
  "http://localhost:3000/admin/analytics?window=1+hour"
```

Direct SQL:
```sql
SELECT
  PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms) p50,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) p95,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) p99
FROM requests
WHERE timestamp > NOW() - INTERVAL '1 hour';
```

---

## Rate Limiting Algorithms

| Algorithm | Best For | Tradeoff |
|-----------|---------|---------|
| Token Bucket | Burst-tolerant APIs | Brief bursts above limit allowed |
| Sliding Window | Strict SLA enforcement | No burst, higher Redis ops |

Configure per-route via `plugins.rateLimit.algorithm: "token-bucket" | "sliding-window"`.

---

## Architecture Decision Records

See `docs/decisions/` for rationale on key engineering choices:

- [001 — Redis Lua atomicity](docs/decisions/001-redis-lua-atomicity.md)
- [002 — Rate limit algorithms](docs/decisions/002-token-bucket-vs-sliding-window.md)
- [003 — Circuit breaker state](docs/decisions/003-circuit-breaker-shared-redis-state.md)

---

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Gateway | Node.js + Express | Async I/O, event loop handles concurrency |
| Rate Limiting | Redis + Lua | Atomic token bucket, shared across instances |
| Circuit Breaker | Redis | Distributed state, consistent across instances |
| Metrics | Prometheus + prom-client | Industry standard, histogram_quantile for real p99 |
| Dashboards | Grafana | 13-panel dashboard, auto-provisioned |
| Tracing | OpenTelemetry + Jaeger | Industry standard, zero-code instrumentation |
| Auth | jsonwebtoken | Industry standard JWT |
| Analytics DB | PostgreSQL | PERCENTILE_CONT for real p99 queries |
| Dashboard | React + Recharts | Live WebSocket charts |
| Load Tests | k6 | Scriptable, CI-friendly |
