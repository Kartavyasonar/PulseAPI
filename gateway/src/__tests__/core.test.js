// Unit tests for PulseAPI core components

// ====================== TOKEN BUCKET TESTS ======================
describe('TokenBucket Rate Limiter', () => {
  let mockRedis;
  const { TokenBucket } = require('../src/plugins/rateLimit');

  beforeEach(() => {
    let store = {};
    mockRedis = {
      eval: jest.fn(async (script, numKeys, key, now, rate, burst) => {
        // Simulate Lua script behavior
        const data = store[key] || { tokens: burst, last_refill: now };
        const elapsed = (now - data.last_refill) / 1000;
        let tokens = Math.min(data.tokens + elapsed * rate, burst);

        let allowed = 0, retryAfter = 0;
        if (tokens >= 1) {
          tokens -= 1;
          allowed = 1;
        } else {
          retryAfter = Math.ceil((1 - tokens) / rate * 1000);
        }

        store[key] = { tokens, last_refill: now };
        return [allowed, Math.floor(tokens), retryAfter];
      }),
    };
  });

  test('allows requests within rate limit', async () => {
    const bucket = new TokenBucket(mockRedis);
    const result = await bucket.consume('user:1', 10, 20);
    expect(result.allowed).toBe(true);
  });

  test('blocks requests when bucket empty', async () => {
    const bucket = new TokenBucket(mockRedis);
    // Exhaust all tokens
    for (let i = 0; i < 20; i++) {
      await bucket.consume('user:2', 10, 20);
    }
    const result = await bucket.consume('user:2', 10, 20);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test('different keys are independent', async () => {
    const bucket = new TokenBucket(mockRedis);
    // Exhaust user:3
    for (let i = 0; i < 5; i++) await bucket.consume('user:3', 10, 5);
    const blocked = await bucket.consume('user:3', 10, 5);
    const allowed = await bucket.consume('user:4', 10, 5);

    expect(blocked.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
  });
});

// ====================== CIRCUIT BREAKER TESTS ======================
describe('CircuitBreaker', () => {
  const { CircuitBreaker, STATES } = require('../src/plugins/circuitBreaker');
  let mockRedis;
  let store;

  beforeEach(() => {
    store = {};
    mockRedis = {
      hgetall: jest.fn(async (key) => store[key] || null),
      hset: jest.fn(async (key, field, value) => {
        if (!store[key]) store[key] = {};
        store[key][field] = value;
      }),
      hmset: jest.fn(async (key, data) => {
        store[key] = { ...store[key], ...data };
      }),
      hincrby: jest.fn(async (key, field, by) => {
        if (!store[key]) store[key] = {};
        store[key][field] = parseInt(store[key][field] || 0) + by;
        return store[key][field];
      }),
      expire: jest.fn(async () => {}),
    };
  });

  const config = { threshold: 3, resetTimeoutMs: 30000 };

  test('starts in CLOSED state', async () => {
    const cb = new CircuitBreaker(mockRedis);
    const state = await cb.getState('http://upstream:4001', config);
    expect(state.state).toBe(STATES.CLOSED);
  });

  test('opens after threshold failures', async () => {
    const cb = new CircuitBreaker(mockRedis);
    const url = 'http://upstream:4001';

    for (let i = 0; i < 3; i++) {
      await cb.recordFailure(url, config);
    }

    const state = await cb.getState(url, config);
    expect(state.state).toBe(STATES.OPEN);
  });

  test('resets to CLOSED after success', async () => {
    const cb = new CircuitBreaker(mockRedis);
    const url = 'http://upstream:4001';

    // Open the circuit
    for (let i = 0; i < 3; i++) await cb.recordFailure(url, config);

    // Record success
    await cb.recordSuccess(url);

    const state = await cb.getState(url, config);
    expect(state.state).toBe(STATES.CLOSED);
    expect(state.failures).toBe(0);
  });

  test('transitions OPEN -> HALF_OPEN after timeout', async () => {
    const cb = new CircuitBreaker(mockRedis);
    const url = 'http://upstream:4001';

    // Simulate open circuit with old timestamp
    store['cb_http___upstream_4001'] = {
      state: STATES.OPEN,
      failures: '5',
      opened_at: String(Date.now() - 35000), // 35 seconds ago
    };

    const shortTimeoutConfig = { ...config, resetTimeoutMs: 30000 };
    const state = await cb.getState(url, shortTimeoutConfig);
    expect(state.state).toBe(STATES.HALF_OPEN);
  });
});

// ====================== LOAD BALANCER TESTS ======================
describe('LoadBalancer', () => {
  const { LoadBalancer } = require('../src/utils/loadBalancer');
  const { STATES } = require('../src/plugins/circuitBreaker');

  let mockCB;

  beforeEach(() => {
    mockCB = {
      getAllStates: jest.fn(async (upstreams) => {
        const states = {};
        upstreams.forEach((u) => (states[u.url] = STATES.CLOSED));
        return states;
      }),
    };
  });

  const upstreams = [
    { url: 'http://upstream1:4001' },
    { url: 'http://upstream2:4002' },
    { url: 'http://upstream3:4003' },
  ];

  test('distributes requests round-robin', async () => {
    const lb = new LoadBalancer();
    const selected = [];
    for (let i = 0; i < 6; i++) {
      const { upstream } = await lb.selectUpstream('route1', upstreams, mockCB, {});
      selected.push(upstream.url);
    }
    expect(selected[0]).toBe(upstreams[0].url);
    expect(selected[1]).toBe(upstreams[1].url);
    expect(selected[2]).toBe(upstreams[2].url);
    expect(selected[3]).toBe(upstreams[0].url);
  });

  test('skips OPEN circuit upstream', async () => {
    const lb = new LoadBalancer();
    mockCB.getAllStates = jest.fn(async (ups) => ({
      'http://upstream1:4001': STATES.OPEN,
      'http://upstream2:4002': STATES.CLOSED,
      'http://upstream3:4003': STATES.CLOSED,
    }));

    const { upstream } = await lb.selectUpstream('route2', upstreams, mockCB, {});
    expect(upstream.url).not.toBe('http://upstream1:4001');
  });

  test('returns null when all circuits open', async () => {
    const lb = new LoadBalancer();
    mockCB.getAllStates = jest.fn(async () => ({
      'http://upstream1:4001': STATES.OPEN,
      'http://upstream2:4002': STATES.OPEN,
      'http://upstream3:4003': STATES.OPEN,
    }));

    const result = await lb.selectUpstream('route3', upstreams, mockCB, {});
    expect(result).toBeNull();
  });
});

// ====================== ROUTE MANAGER TESTS ======================
describe('RouteManager', () => {
  const { RouteManager } = require('../src/utils/routeManager');
  let mockDb;

  beforeEach(() => {
    mockDb = {
      query: jest.fn(async (sql) => ({
        rows: [
          { id: 'api-service', path_prefix: '/api', upstreams: [], plugins: {} },
          { id: 'public-service', path_prefix: '/public', upstreams: [], plugins: {} },
        ],
      })),
    };
  });

  test('loads routes from DB', async () => {
    const rm = new RouteManager(mockDb);
    await rm.load();
    expect(rm.list()).toHaveLength(2);
  });

  test('matches longest prefix', async () => {
    const rm = new RouteManager(mockDb);
    rm.routes.set('short', { id: 'short', pathPrefix: '/api', upstreams: [], plugins: {} });
    rm.routes.set('long', { id: 'long', pathPrefix: '/api/v2', upstreams: [], plugins: {} });

    const match = rm.match('/api/v2/users');
    expect(match.id).toBe('long');
  });

  test('returns null for unmatched path', async () => {
    const rm = new RouteManager(mockDb);
    rm.routes.set('api', { id: 'api', pathPrefix: '/api', upstreams: [], plugins: {} });
    expect(rm.match('/unknown/path')).toBeNull();
  });
});
