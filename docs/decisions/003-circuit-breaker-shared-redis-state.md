# 003 — Store Circuit Breaker State in Redis, Not In-Memory

**Status:** Accepted  
**Date:** 2025-04-12  
**Author:** Kartavya Sonar

---

## Context

The circuit breaker needs to track failure counts and circuit state
(CLOSED/OPEN/HALF_OPEN) per upstream URL.

The obvious implementation stores this in-memory (a JavaScript Map). This
works correctly for a single gateway instance. The problem appears when
scaling horizontally to multiple instances:

```
Instance A: upstream1 fails 5 times -> circuit OPEN (in A's memory)
Instance B: doesn't know -> keeps routing to upstream1 -> more failures
Instance C: doesn't know -> keeps routing to upstream1 -> more failures

Result: circuit breaker provides no protection at scale
```

Each instance has an independent view of upstream health. The circuit
breaker's purpose — to stop cascading failures — is defeated.

---

## Decision

Store all circuit breaker state in Redis hashes:

```
Key:    cb:http___upstream1_4001
Fields: state, failures, opened_at
```

All gateway instances share the same Redis, so:
- When instance A opens a circuit, instances B and C see it immediately
- The HALF_OPEN probe from any instance (first to pass the timeout check)
  benefits all instances
- State survives instance restarts (circuit doesn't reset on deploy)

State transitions in Redis are safe because:
- `HINCRBY` (increment failures) is atomic
- State writes use `HMSET` which is atomic  
- The check-then-transition (OPEN->HALF_OPEN on timeout) runs in `getState()`
  which is idempotent — multiple instances transitioning simultaneously is fine

---

## Consequences

**Positive:**
- Correct behavior at any number of instances
- Circuit state survives gateway restarts
- Centralized view — `/admin/circuit-breakers` shows true global state

**Negative:**
- Redis is now on the critical path for every proxied request (2 calls:
  `getState` before, `recordSuccess/Failure` after)
- Mitigated: Redis is already required for rate limiting, so no new
  infrastructure dependency
- Mitigated: both calls are O(1) Redis hash operations (~0.1ms each)
- Redis failure means circuit breaker degrades gracefully — `getAllStates`
  catching errors would return CLOSED (fail open), letting traffic through

---

## Alternatives rejected

**Gossip protocol between instances:** complex to implement correctly,
latency between state convergence still allows window of incorrectness.

**Sticky load balancing (route client to same instance):** solves the
isolation problem but prevents horizontal scaling and adds LB complexity.
