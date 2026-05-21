# 002 — Support Both Token Bucket and Sliding Window Algorithms

**Status:** Accepted  
**Date:** 2025-04-11  
**Author:** Kartavya Sonar

---

## Context

Two common rate limiting algorithms with fundamentally different tradeoffs:

### Token Bucket
- Tokens accumulate at `rate` per second up to `burst` maximum
- Each request consumes one token
- Allows short bursts (up to `burst` requests) without throttling
- After burst exhausted, steady-state throughput = `rate`

### Sliding Window Log
- Maintains a log of all request timestamps in a sorted set
- Window moves with time — no fixed reset boundary
- Strictly enforces N requests per window
- No burst allowance — the Nth+1 request is always denied

### The problem with fixed windows (neither algorithm)
A fixed window (e.g. 100 req/minute, reset at :00) allows a burst of 200 
requests at 11:59:59 + 12:00:00 — one window's worth at the boundary.
Neither token bucket nor sliding window has this problem.

---

## Decision

Implement both algorithms, make it configurable per-route via the `algorithm`
field in the route's `rateLimit` plugin config:

```json
{
  "rateLimit": {
    "enabled": true,
    "requestsPerSecond": 50,
    "burst": 100,
    "algorithm": "token-bucket"
  }
}
```

Default: `token-bucket` (more forgiving for typical API traffic).

**Token bucket** used for: `/api/*`, `/secure/*` — burst-tolerant  
**Sliding window** used for: `/public/*` — strict, predictable

---

## Consequences

**Positive:**
- Routes can choose algorithm based on their SLA requirements
- Demonstrates understanding of algorithm tradeoffs in interviews
- Sliding window is demonstrably stricter — visible in rate-limit headers

**Negative:**
- More code to maintain (two implementations)
- Sliding window uses sorted sets — more Redis memory than token bucket hash
  (~48 bytes per member vs flat hash)
- Sliding window Lua script does ZREMRANGEBYSCORE + ZCARD + ZADD vs
  token bucket's HMGET + HMSET — slightly more Redis ops per request
