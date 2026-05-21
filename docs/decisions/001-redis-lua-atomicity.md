# 001 — Use Redis Lua Scripts for Atomic Rate Limit Operations

**Status:** Accepted  
**Date:** 2025-04-11  
**Author:** Kartavya Sonar

---

## Context

The naive rate limiter implementation (see git history, commit `e3a1f2`) used
an in-memory Map and a simple counter. It had a classic race condition:

```
T=0: Request A reads counter = 9 (limit = 10), sees: allowed
T=0: Request B reads counter = 9 (limit = 10), sees: allowed  ← same value
T=1: Request A increments -> 10
T=1: Request B increments -> 11  ← both allowed, limit violated
```

Two concurrent requests both read the same value, both see it below the limit,
both get allowed. This is the TOCTOU (time-of-check-time-of-use) problem.

The fix requires an atomic read-modify-write. Options considered:

1. **Redis INCR + EXPIRE** — atomic increment, but can't implement token bucket refill atomically
2. **Redis transactions (MULTI/EXEC)** — optimistic locking with WATCH, but requires retry on conflict
3. **Redis Lua scripts** — evaluated atomically by Redis, no other commands interleave

---

## Decision

Use Lua scripts executed via `redis.eval()`.

Redis guarantees: *"Redis uses a single Lua interpreter to run all the scripts,
and Redis also guarantees that a script is executed in an atomic way: no other
script or Redis command will be executed while a script is being executed."*

The token bucket Lua script (`rateLimit.js`) does in one atomic operation:
1. Read `{tokens, last_refill}` from Redis hash
2. Compute elapsed time and refill tokens
3. Consume one token if available (or deny)
4. Write updated state back
5. Set TTL

---

## Consequences

**Positive:**
- No race conditions — guaranteed by Redis single-threaded Lua execution
- Works correctly across multiple gateway instances (unlike in-memory Map)
- Single network round-trip per request (Lua runs server-side)

**Negative:**
- Lua scripts are harder to debug than plain Redis commands
- Script errors fail silently if not handled carefully
- Lua runs blocking in Redis — long scripts would block other commands
  (ours is <10 Redis ops, runs in microseconds, acceptable)

---

## Alternatives rejected

**Database-level locking (PostgreSQL SELECT FOR UPDATE):** too slow —
would add ~5-20ms per request on the rate-limit hot path.

**Application-level mutex (Node.js):** works for single instance only,
fails in multi-instance deployment.
