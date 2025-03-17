const STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

class CircuitBreaker {
  constructor(redis) {
    this.redis = redis;
  }

  _key(url) {
    return `cb:${url.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }

  async getState(url, config) {
    const key = this._key(url);
    const data = await this.redis.hgetall(key);
    if (!data || !data.state) return { state: STATES.CLOSED, failures: 0 };

    if (data.state === STATES.OPEN) {
      const elapsed = Date.now() - parseInt(data.opened_at || 0);
      if (elapsed > config.resetTimeoutMs) {
        await this.redis.hset(key, 'state', STATES.HALF_OPEN);
        return { state: STATES.HALF_OPEN, failures: parseInt(data.failures || 0) };
      }
    }

    return {
      state: data.state,
      failures: parseInt(data.failures || 0),
      openedAt: parseInt(data.opened_at || 0),
    };
  }

  async recordSuccess(url) {
    const key = this._key(url);
    await this.redis.hmset(key, { state: STATES.CLOSED, failures: 0, opened_at: 0 });
    await this.redis.expire(key, 300);
  }

  async recordFailure(url, config) {
    const key = this._key(url);
    const failures = await this.redis.hincrby(key, 'failures', 1);
    if (failures >= config.threshold) {
      await this.redis.hmset(key, { state: STATES.OPEN, opened_at: Date.now() });
    }
    await this.redis.expire(key, 300);
    return failures;
  }

  async getAllStates(upstreams) {
    if (!upstreams.length) return {};
    // pipeline all hgetall calls instead of sequential awaits
    const pipeline = this.redis.pipeline();
    for (const u of upstreams) pipeline.hgetall(this._key(u.url));
    const results = await pipeline.exec();

    const states = {};
    upstreams.forEach((u, i) => {
      const d = results[i][1];
      states[u.url] = d ? (d.state || STATES.CLOSED) : STATES.CLOSED;
    });
    return states;
  }
}

function circuitBreakerPlugin(redis) {
  const breaker = new CircuitBreaker(redis);
  return {
    breaker,
    middleware: async (req, res, next, config) => {
      if (!config || !config.enabled) return next();
      req.circuitBreaker = breaker;
      req.circuitBreakerConfig = config;
      next();
    },
  };
}

module.exports = { circuitBreakerPlugin, CircuitBreaker, STATES };
