// Unit tests for PulseAPI core components

describe('TokenBucket', () => {
  const { TokenBucket } = require('../plugins/rateLimit');
  let store, mockRedis;

  beforeEach(() => {
    store = {};
    mockRedis = {
      eval: jest.fn(async (script, numKeys, key, now, rate, burst) => {
        const data = store[key] || { tokens: burst, last_refill: now };
        const elapsed = (now - data.last_refill) / 1000;
        let tokens = Math.min(data.tokens + elapsed * rate, burst);
        let allowed = 0, retryAfter = 0;
        if (tokens >= 1) { tokens -= 1; allowed = 1; }
        else { retryAfter = Math.ceil((1 - tokens) / rate * 1000); }
        store[key] = { tokens, last_refill: now };
        return [allowed, Math.floor(tokens), retryAfter];
      }),
    };
  });

  test('allows requests within rate limit', async () => {
    const b = new TokenBucket(mockRedis);
    expect((await b.consume('u:1', 10, 20)).allowed).toBe(true);
  });

  test('blocks when bucket is empty', async () => {
    const b = new TokenBucket(mockRedis);
    for (let i = 0; i < 20; i++) await b.consume('u:2', 10, 20);
    const r = await b.consume('u:2', 10, 20);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  test('different keys are independent', async () => {
    const b = new TokenBucket(mockRedis);
    for (let i = 0; i < 5; i++) await b.consume('u:3', 10, 5);
    expect((await b.consume('u:3', 10, 5)).allowed).toBe(false);
    expect((await b.consume('u:4', 10, 5)).allowed).toBe(true);
  });
});

describe('CircuitBreaker', () => {
  const { CircuitBreaker, STATES } = require('../plugins/circuitBreaker');
  let store, mockRedis;

  beforeEach(() => {
    store = {};
    mockRedis = {
      hgetall:  jest.fn(async k => store[k] || null),
      hset:     jest.fn(async (k, f, v) => { store[k] = store[k] || {}; store[k][f] = String(v); }),
      hmset:    jest.fn(async (k, d) => { store[k] = { ...store[k], ...Object.fromEntries(Object.entries(d).map(([k,v])=>[k,String(v)])) }; }),
      hincrby:  jest.fn(async (k, f, by) => { store[k] = store[k] || {}; store[k][f] = String(parseInt(store[k][f] || 0) + by); return parseInt(store[k][f]); }),
      pipeline: jest.fn(() => ({ hgetall: jest.fn().mockReturnThis(), exec: jest.fn(async () => []) })),
      expire:   jest.fn(async () => {}),
    };
  });

  const cfg = { threshold: 3, resetTimeoutMs: 30000 };

  test('starts CLOSED', async () => {
    const cb = new CircuitBreaker(mockRedis);
    expect((await cb.getState('http://u:4001', cfg)).state).toBe(STATES.CLOSED);
  });

  test('opens after threshold failures', async () => {
    const cb = new CircuitBreaker(mockRedis);
    for (let i = 0; i < 3; i++) await cb.recordFailure('http://u:4001', cfg);
    expect((await cb.getState('http://u:4001', cfg)).state).toBe(STATES.OPEN);
  });

  test('resets to CLOSED on success', async () => {
    const cb = new CircuitBreaker(mockRedis);
    for (let i = 0; i < 3; i++) await cb.recordFailure('http://u:4001', cfg);
    await cb.recordSuccess('http://u:4001');
    const s = await cb.getState('http://u:4001', cfg);
    expect(s.state).toBe(STATES.CLOSED);
    expect(s.failures).toBe(0);
  });

  test('transitions OPEN -> HALF_OPEN after timeout', async () => {
    const cb = new CircuitBreaker(mockRedis);
    const key = cb._key('http://u:4001');
    store[key] = { state: 'open', failures: '5', opened_at: String(Date.now() - 35000) };
    expect((await cb.getState('http://u:4001', cfg)).state).toBe(STATES.HALF_OPEN);
  });
});

describe('LoadBalancer', () => {
  const { LoadBalancer } = require('../utils/loadBalancer');
  const { STATES } = require('../plugins/circuitBreaker');

  const ups = [
    { url: 'http://u1:4001' }, { url: 'http://u2:4002' }, { url: 'http://u3:4003' },
  ];

  let mockCB;
  beforeEach(() => {
    mockCB = { getAllStates: jest.fn(async us => Object.fromEntries(us.map(u => [u.url, STATES.CLOSED]))) };
  });

  test('distributes round-robin', async () => {
    const lb = new LoadBalancer();
    const selected = [];
    for (let i = 0; i < 6; i++) selected.push((await lb.selectUpstream('r', ups, mockCB, {})).upstream.url);
    expect(selected[0]).toBe(ups[0].url);
    expect(selected[1]).toBe(ups[1].url);
    expect(selected[3]).toBe(ups[0].url);
  });

  test('skips OPEN upstream', async () => {
    const lb = new LoadBalancer();
    mockCB.getAllStates = jest.fn(async () => ({ 'http://u1:4001': STATES.OPEN, 'http://u2:4002': STATES.CLOSED, 'http://u3:4003': STATES.CLOSED }));
    const r = await lb.selectUpstream('r', ups, mockCB, {});
    expect(r.upstream.url).not.toBe('http://u1:4001');
  });

  test('returns null when all OPEN', async () => {
    const lb = new LoadBalancer();
    mockCB.getAllStates = jest.fn(async () => Object.fromEntries(ups.map(u => [u.url, STATES.OPEN])));
    expect(await lb.selectUpstream('r', ups, mockCB, {})).toBeNull();
  });
});

describe('RouteManager', () => {
  const { RouteManager } = require('../utils/routeManager');

  test('matches longest prefix', async () => {
    const rm = new RouteManager({ query: async () => ({ rows: [] }) });
    rm.routes.set('short', { id: 'short', pathPrefix: '/api',    upstreams: [], plugins: {} });
    rm.routes.set('long',  { id: 'long',  pathPrefix: '/api/v2', upstreams: [], plugins: {} });
    expect(rm.match('/api/v2/users').id).toBe('long');
  });

  test('returns null for unmatched path', async () => {
    const rm = new RouteManager({ query: async () => ({ rows: [] }) });
    rm.routes.set('api', { id: 'api', pathPrefix: '/api', upstreams: [], plugins: {} });
    expect(rm.match('/unknown')).toBeNull();
  });
});
