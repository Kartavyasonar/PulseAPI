# PulseAPI Load Tests

Uses [Locust](https://locust.io) — Python-based, scriptable, supports custom metrics.

## Install

```bash
pip install locust
```

## Run (headless, CI mode)

```bash
locust -f locustfile.py \
  --host=http://localhost:3000 \
  --users=100 \
  --spawn-rate=10 \
  --run-time=60s \
  --headless
```

## Run (with UI)

```bash
locust -f locustfile.py --host=http://localhost:3000
# open http://localhost:8089
```

## User classes

| Class | Weight | Purpose |
|-------|--------|---------|
| `NormalUser` | 70% | Realistic traffic mix across all routes |
| `RateLimitUser` | 20% | Hammers `/public/` to trigger 429s |
| `CircuitBreakerUser` | 10% | Probes unstable upstream path |

## Failure gates (CI)

The test exits with code 1 if:
- `p99 > 500ms` — fetched from `/admin/analytics` after test
- `error_rate > 5%` — 5xx responses, intentional 429s excluded

## Example output

```
============================================================
PulseAPI Load Test Summary
============================================================
  Total requests   : 48230
  Rate limited 429s: 3812 (7.9%)
  Circuit open 503s: 14
  Errors (5xx)     : 183 (0.4%)
  p99 latency      : 187ms
============================================================
  ✅ p99 187ms within threshold
  ✅ error rate 0.4% within threshold

  ✅ All gates passed
```
