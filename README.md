# ⚡ PulseAPI — Production-Grade API Gateway

A fully functional API gateway built from scratch. Proxies requests, enforces rate limiting via token bucket algorithm, handles JWT auth, circuit breaking, retry with exponential backoff, and shows a live analytics dashboard.

## Architecture

```
Client → PulseAPI Gateway (Node.js/Express)
              │
              ├── Token Bucket Rate Limiter (Redis)
              ├── JWT Auth Middleware
              ├── Circuit Breaker (Redis state)
              ├── Round-Robin Load Balancer
              ├── Retry + Exponential Backoff
              │
              ├── upstream-1 (mock service, 5% fail rate)
              ├── upstream-2 (mock service, 2% fail rate)
              └── upstream-3 (mock service, stable)

PostgreSQL  ← Request Logs (async buffered writes)
Dashboard   ← WebSocket (live stats every 1s)
```

## Quick Start

```bash
# Start everything
docker compose up -d --build

# Wait ~30 seconds for DB init, then:
curl http://localhost:3000/health

# Run the demo script
chmod +x scripts/demo.sh && ./scripts/demo.sh
```

**Services:**
- Gateway: http://localhost:3000
- Dashboard: http://localhost:5173
- Admin API: http://localhost:3000/admin (X-Api-Key: admin-secret-key)
- WebSocket: ws://localhost:3000/ws

## Features

### Rate Limiting — Token Bucket Algorithm
Implemented from scratch in `gateway/src/plugins/rateLimit.js` using Redis Lua scripts for atomic operations.

```bash
# Trigger rate limiting on /public/ (10 req/s limit)
for i in {1..20}; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/public/test; done
```

### Circuit Breaker — State Machine
Three states: `CLOSED → OPEN → HALF_OPEN → CLOSED`
- Opens after 5 consecutive 5xx failures
- Auto-recovers after 30 seconds (HALF_OPEN probe)
- State stored in Redis — shared across all gateway instances

```bash
# Check circuit breaker states
curl -H "X-Api-Key: admin-secret-key" http://localhost:3000/admin/circuit-breakers

# Reset a circuit manually
curl -X POST http://localhost:3000/admin/circuit-breakers/reset \
  -H "X-Api-Key: admin-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"upstream": "http://upstream1:4001"}'
```

### Hot Route Reload — No Restart Required
```bash
curl -X POST http://localhost:3000/admin/routes \
  -H "X-Api-Key: admin-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-service",
    "pathPrefix": "/my-service",
    "upstreams": [{"url": "http://my-backend:8080", "weight": 1}],
    "plugins": {
      "rateLimit": {"enabled": true, "requestsPerSecond": 100, "burst": 200},
      "auth": {"enabled": false},
      "retry": {"enabled": true, "maxRetries": 3, "backoffMs": 100},
      "circuitBreaker": {"enabled": true, "threshold": 5, "resetTimeoutMs": 30000}
    }
  }'
```

### JWT Auth
```bash
# Generate a test token
TOKEN=$(curl -s -X POST http://localhost:3000/admin/token \
  -H "X-Api-Key: admin-secret-key" | jq -r .token)

# Hit a secured route
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/secure/data
```

### Analytics — p50/p95/p99 from PostgreSQL
```bash
curl -H "X-Api-Key: admin-secret-key" "http://localhost:3000/admin/analytics?window=1+hour"
```

### Live Load Test
```bash
# Terminal 1: blast 100 req/s
while true; do
  for i in {1..10}; do curl -s http://localhost:3000/api/test &; done
  sleep 0.1
done

# Terminal 2: watch dashboard
open http://localhost:5173
```

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Gateway | Node.js + Express | Async I/O, huge ecosystem |
| Rate Limiting | Redis + Lua scripts | Atomic token bucket, shared state |
| Circuit Breaker | Redis | Distributed state across instances |
| Auth | jsonwebtoken | Industry standard JWT |
| Analytics DB | PostgreSQL | PERCENTILE_CONT for p99 queries |
| Dashboard | React + Recharts | Real-time WebSocket charts |
| Live updates | WebSocket | Push stats every 1s |
| Container | Docker Compose | One-command startup |
| CI/CD | GitHub Actions | Test → Build → Integration |

## API Reference

### Admin (all require `X-Api-Key: admin-secret-key`)

| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/routes | List all routes |
| POST | /admin/routes | Create/update route (hot reload) |
| DELETE | /admin/routes/:id | Delete route |
| GET | /admin/analytics | p50/p95/p99 + error rates |
| GET | /admin/circuit-breakers | All CB states |
| POST | /admin/circuit-breakers/reset | Reset a circuit |
| POST | /admin/token | Generate test JWT |

### Default Routes

| Path | Upstream | Auth | Rate Limit |
|------|----------|------|-----------|
| /api/* | upstream1,2,3 (load balanced) | No | 50 req/s |
| /public/* | upstream3 | No | 10 req/s |
| /secure/* | upstream1 | JWT required | 20 req/s |

## Tests

```bash
cd gateway && npm test
```

Tests cover:
- Token bucket algorithm (allows/blocks correctly, independent keys)
- Circuit breaker state machine (closed/open/half-open transitions)
- Load balancer (round-robin, skips open circuits, null on all-open)
- Route manager (longest-prefix matching, hot reload)

## Database Schema

```sql
requests (
  id          BIGSERIAL PRIMARY KEY,
  timestamp   TIMESTAMPTZ,   -- indexed
  method      VARCHAR(10),
  path        TEXT,
  route_id    VARCHAR(100),  -- indexed
  upstream    VARCHAR(200),
  client_ip   INET,          -- indexed
  api_key     VARCHAR(100),
  status_code INTEGER,       -- indexed
  latency_ms  INTEGER,
  retries     INTEGER,
  error       TEXT
)
```

p99 query:
```sql
SELECT PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms)
FROM requests
WHERE timestamp > NOW() - INTERVAL '1 hour';
```
