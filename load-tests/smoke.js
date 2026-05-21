// k6 smoke test — runs in CI against a live gateway
// Low VUs, short duration: catches regressions, not performance
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('error_rate');

export const options = {
  vus: 3,
  duration: '20s',
  thresholds: {
    http_req_failed:   ['rate<0.05'],   // <5% errors
    http_req_duration: ['p(95)<800'],   // 95th percentile under 800ms
    error_rate:        ['rate<0.05'],
  },
};

const BASE = __ENV.GATEWAY_URL || 'http://localhost:3000';

export default function () {
  // 1. Health check
  {
    const r = http.get(`${BASE}/health`);
    const ok = check(r, {
      'health 200': res => res.status === 200,
      'health body has status': res => JSON.parse(res.body).status !== undefined,
    });
    errorRate.add(!ok);
  }

  // 2. Proxy route
  {
    const r = http.get(`${BASE}/api/smoke-test`);
    const ok = check(r, {
      'proxy not 500': res => res.status < 500,
      'x-gateway header': res => res.headers['X-Gateway'] !== undefined,
    });
    errorRate.add(!ok);
  }

  // 3. Rate limit header present
  {
    const r = http.get(`${BASE}/api/ping`);
    check(r, {
      'ratelimit header present': res =>
        res.headers['X-Ratelimit-Remaining'] !== undefined || res.status === 429,
    });
  }

  // 4. Admin endpoint auth
  {
    const unauth = http.get(`${BASE}/admin/routes`);
    check(unauth, { 'admin rejects no key': res => res.status === 401 || res.status === 403 });

    const auth = http.get(`${BASE}/admin/routes`, {
      headers: { 'X-Api-Key': __ENV.ADMIN_KEY || 'admin-secret-key' },
    });
    check(auth, { 'admin accepts key': res => res.status === 200 });
  }

  // 5. Metrics endpoint
  {
    const r = http.get(`${BASE}/metrics`);
    check(r, {
      'metrics 200': res => res.status === 200,
      'metrics has pulseapi counter': res => res.body.includes('pulseapi_http_requests_total'),
    });
  }

  sleep(0.5);
}
