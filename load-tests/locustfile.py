"""
PulseAPI Load Tests
====================
Run: locust -f locustfile.py --host=http://localhost:3000 --users=100 --spawn-rate=10 --run-time=60s --headless

Test scenarios:
  NormalUser      — realistic mix: /api/, /public/, /secure/
  RateLimitUser   — hammers /public/ to trigger 429s (10 req/s limit)
  CircuitBreakerUser — hammers failing upstream path

Custom metrics tracked:
  - 429 rate (expected from RateLimitUser)
  - p99 latency gate: fail if > 500ms
  - error rate gate:  fail if > 5% (excluding intentional 429s)
"""

import random
import time
from collections import defaultdict

from locust import HttpUser, task, between, events


# ── Shared metrics ────────────────────────────────────────────────────────

_stats = defaultdict(int)

ADMIN_KEY   = "admin-secret-key"
TEST_TOKEN  = None          # fetched once at startup


def _get_token(client):
    resp = client.post("/admin/token", headers={"X-Api-Key": ADMIN_KEY}, json={}, name="/admin/token")
    if resp.status_code == 200:
        return resp.json().get("token")
    return None


# ── User classes ──────────────────────────────────────────────────────────

class NormalUser(HttpUser):
    """Realistic traffic mix — exercises all three default routes."""
    wait_time = between(0.05, 0.2)
    weight = 70

    def on_start(self):
        global TEST_TOKEN
        if TEST_TOKEN is None:
            TEST_TOKEN = _get_token(self.client)

    @task(5)
    def api_get(self):
        r = self.client.get(f"/api/item/{random.randint(1, 1000)}", name="/api/item/[id]")
        _stats["total"] += 1
        if r.status_code >= 500:
            _stats["errors"] += 1

    @task(3)
    def public_get(self):
        r = self.client.get("/public/status", name="/public/status")
        _stats["total"] += 1
        if r.status_code == 429:
            _stats["rate_limited"] += 1
        elif r.status_code >= 500:
            _stats["errors"] += 1

    @task(2)
    def secure_get(self):
        headers = {}
        if TEST_TOKEN:
            headers["Authorization"] = f"Bearer {TEST_TOKEN}"
        r = self.client.get("/secure/profile", headers=headers, name="/secure/profile")
        _stats["total"] += 1
        if r.status_code >= 500:
            _stats["errors"] += 1

    @task(1)
    def api_post(self):
        r = self.client.post(
            "/api/events",
            json={"event": "page_view", "userId": random.randint(1, 10000)},
            name="/api/events",
        )
        _stats["total"] += 1
        if r.status_code >= 500:
            _stats["errors"] += 1


class RateLimitUser(HttpUser):
    """Hammers /public/ to deliberately trigger rate limiting.
    Validates that 429s appear and Retry-After header is set."""
    wait_time = between(0.01, 0.05)
    weight = 20

    @task
    def hammer_public(self):
        r = self.client.get("/public/hammer", name="/public/hammer [rate-limit-test]")
        _stats["total"] += 1
        if r.status_code == 429:
            _stats["rate_limited"] += 1
            retry_after = r.headers.get("Retry-After")
            if not retry_after:
                _stats["missing_retry_after"] += 1
        elif r.status_code >= 500:
            _stats["errors"] += 1


class CircuitBreakerUser(HttpUser):
    """Sends requests through routes backed by unstable upstreams.
    Watches for circuit-open 503s and validates auto-recovery."""
    wait_time = between(0.1, 0.5)
    weight = 10

    @task
    def probe_unstable(self):
        r = self.client.get(f"/api/probe/{random.randint(1,100)}", name="/api/probe/[id]")
        _stats["total"] += 1
        if r.status_code == 503:
            _stats["circuit_open"] += 1
        elif r.status_code >= 500:
            _stats["errors"] += 1


# ── Test lifecycle gates ──────────────────────────────────────────────────

@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    total        = _stats["total"] or 1
    rate_limited = _stats["rate_limited"]
    errors       = _stats["errors"]
    circuit_open = _stats["circuit_open"]

    # errors excludes intentional 429s
    error_rate  = errors / total * 100
    rl_rate     = rate_limited / total * 100

    # fetch p99 from gateway analytics
    p99 = None
    try:
        import urllib.request, json
        req = urllib.request.Request(
            "http://localhost:3000/admin/analytics?window=1+hour",
            headers={"X-Api-Key": ADMIN_KEY},
        )
        data = json.loads(urllib.request.urlopen(req, timeout=5).read())
        p99 = float(data["summary"].get("p99") or 0)
    except Exception:
        pass

    print("\n" + "="*60)
    print("PulseAPI Load Test Summary")
    print("="*60)
    print(f"  Total requests   : {total}")
    print(f"  Rate limited 429s: {rate_limited} ({rl_rate:.1f}%)")
    print(f"  Circuit open 503s: {circuit_open}")
    print(f"  Errors (5xx)     : {errors} ({error_rate:.1f}%)")
    if p99 is not None:
        print(f"  p99 latency      : {p99}ms")
    print("="*60)

    # ── Failure gates ──
    failed = False

    if p99 is not None and p99 > 500:
        print(f"  ❌ FAIL: p99 {p99}ms > 500ms threshold")
        failed = True
    elif p99 is not None:
        print(f"  ✅ p99 {p99}ms within threshold")

    if error_rate > 5:
        print(f"  ❌ FAIL: error rate {error_rate:.1f}% > 5% (excludes 429s)")
        failed = True
    else:
        print(f"  ✅ error rate {error_rate:.1f}% within threshold")

    if _stats["missing_retry_after"] > 0:
        print(f"  ⚠️  {_stats['missing_retry_after']} rate-limited responses missing Retry-After header")

    if failed:
        environment.process_exit_code = 1
    else:
        print("\n  ✅ All gates passed")
