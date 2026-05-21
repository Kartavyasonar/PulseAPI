import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  vus: 200,
  duration: '2m',
};

const headers = {
  'x-api-key': 'pk_loadtest_72a5275e1d65d9bd89f2ae7dc2b685d80d2581f6be396a3a',
};

export default function () {
  const res = http.get(
    'http://localhost:3000/api/upstream1/test',
    { headers }
  );

  check(res, {
    'status 200': (r) => r.status === 200,
    'latency < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(0.1);
}