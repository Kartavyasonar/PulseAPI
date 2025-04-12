# ⚡ PulseAPI — Production-Grade API Gateway

A fully functional API gateway built from scratch. Proxies requests, enforces
rate limiting via token bucket or sliding window algorithms, handles JWT auth,
circuit breaking, retry with exponential backoff, multi-tenancy, distributed
tracing, and a live analytics dashboard.

## Quick Start

```bash
docker compose up -d --build
# wait ~30s for DB init
curl http://localhost:3000/health
./scripts/demo.sh
```

**Services after startup:**

| Service | URL |
|---------|-----|
| Gateway | http://localhost:3000 |
| Dashboard | http://localhost:5173 |
| Admin API | http://localhost:3000/admin (X-Api-Key: admin-secret-key) |
| Jaeger UI | http://localhost:16686 |
| WebSocket | ws://localhost:3000/ws |

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

PostgreSQL ← Request logs (async, 500ms buffer)
WebSocket  → Dashboard (live stats, 1s push)
Jaeger     ← Distributed traces (OTel)
```

---

## Features

### Rate Limiting — Token Bucket & Sliding Window

Implemented from scratch in `gateway/src/plugins/rateLimit.js` using Redis
Lua scripts for atomicity (no race conditions under concurrent load).

```bash
# trigger rate limiting on /public/ (10 req/s sliding window)
for i in {1..20}; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/public/test; done
```

### Circuit Breaker — CLOSED / OPEN / HALF_OPEN

State stored in Redis (shared across all gateway instances). Opens after 5
consecutive 5xx failures, auto-recovers after 30s via HALF_OPEN probe.

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
# route is live immediately — no restart
```

### JWT Auth

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/admin/token \
  -H "X-Api-Key: admin-secret-key" | jq -r .token)

curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/secure/data
```

---

## Multi-Tenant Quota Management

Each tenant has an isolated rate limit quota enforced at the Redis layer.
Tenant API keys are stored as SHA-256 hashes — raw keys never persisted.

| Tier       | Rate Limit  | Burst |
|------------|------------|-------|
| Free       | 10 req/s   | 20    |
| Pro        | 100 req/s  | 200   |
| Enterprise | 1000 req/s | 2000  |

```bash
# create a tenant
curl -X POST http://localhost:3000/admin/tenants \
  -H "X-Api-Key: admin-secret-key" -H "Content-Type: application/json" \
  -d '{"id":"acme","name":"Acme Corp","tier":"pro"}'

# generate API key (raw key returned once, hash stored)
curl -X POST http://localhost:3000/admin/tenants/acme/keys \
  -H "X-Api-Key: admin-secret-key"

# view usage
curl -H "X-Api-Key: admin-secret-key" http://localhost:3000/admin/tenants/acme/usage
```

---

## Rate Limiting Algorithms

| Algorithm       | Best For               | Tradeoff |
|----------------|------------------------|---------|
| Token Bucket   | Burst-tolerant APIs    | Brief bursts above limit allowed |
| Sliding Window | Strict SLA enforcement | No burst, higher Redis ops |

Configure per-route via `plugins.rateLimit.algorithm: "token-bucket" | "sliding-window"`.

---

## Distributed Tracing — OpenTelemetry + Jaeger

Every request gets a trace ID propagated through gateway → upstream.
View traces at **http://localhost:16686**

Trace ID also stored in `requests.trace_id` — join with analytics:

```sql
SELECT * FROM requests WHERE trace_id = 'abc123...';
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

## Load Testing

```bash
pip install locust
locust -f load-tests/locustfile.py \
  --host=http://localhost:3000 --users=100 --spawn-rate=10 \
  --run-time=60s --headless
```

CI failure gates: p99 > 500ms or error rate > 5% exits non-zero.

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
| Tracing | OpenTelemetry + Jaeger | Industry standard, zero-code instrumentation |
| Auth | jsonwebtoken | Industry standard JWT |
| Analytics DB | PostgreSQL | PERCENTILE_CONT for real p99 queries |
| Dashboard | React + Recharts | Live WebSocket charts |
| Load Tests | Locust | Scriptable, CI-friendly failure gates |
| CI/CD | GitHub Actions | test → build → integration |

---

## SDE Interview Q&A

**"How does rate limiting work?"** — Token bucket: each client has N tokens,
refilled at `rate/s`. Implemented in Redis Lua for atomicity. See
[ADR-001](docs/decisions/001-redis-lua-atomicity.md) for why Lua.

**"Token bucket vs sliding window?"** — Bucket allows bursts, window is strict.
Both implemented, configurable per route. See [ADR-002](docs/decisions/002-token-bucket-vs-sliding-window.md).

**"What is a circuit breaker?"** — Three-state machine. 5 consecutive 5xx →
OPEN (instant 503). After 30s → HALF_OPEN probe. Success → CLOSED.
State in Redis so all instances agree. See [ADR-003](docs/decisions/003-circuit-breaker-shared-redis-state.md).

**"How do you handle multi-tenancy?"** — Per-tenant quota in DB, looked up by
API key SHA-256 hash. Rate limit key namespaced by tenant ID. Raw keys never stored.

**"How would you scale this to 1M req/s?"** — Horizontal gateway instances
(stateless — all state in Redis/PG). Redis Cluster for rate limiting at scale.
PG partitioned by timestamp for analytics. CDN in front for static rate limiting.
