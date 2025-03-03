// Circuit Breaker — State machine: CLOSED -> OPEN -> HALF-OPEN -> CLOSED
// State stored in Redis so all gateway instances share state

const STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

class CircuitBreaker {
  constructor(redis) {
    this.redis = redis;
  }

  _key(upstreamUrl) {
    return `cb:${upstreamUrl.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }

  async getState(upstreamUrl, config) {
    const key = this._key(upstreamUrl);
    const data = await this.redis.hgetall(key);

    if (!data || !data.state) {
      return { state: STATES.CLOSED, failures: 0 };
    }

    // Check if OPEN circuit should transition to HALF_OPEN
    if (data.state === STATES.OPEN) {
      const openedAt = parseInt(data.opened_at || 0);
      const elapsed = Date.now() - openedAt;
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

  async recordSuccess(upstreamUrl) {
    const key = this._key(upstreamUrl);
    await this.redis.hmset(key, {
      state: STATES.CLOSED,
      failures: 0,
      opened_at: 0,
    });
    await this.redis.expire(key, 300);
  }

  async recordFailure(upstreamUrl, config) {
    const key = this._key(upstreamUrl);
    const failures = await this.redis.hincrby(key, 'failures', 1);

    if (failures >= config.threshold) {
      await this.redis.hmset(key, {
        state: STATES.OPEN,
        opened_at: Date.now(),
      });
    }
    await this.redis.expire(key, 300);
    return failures;
  }

  async getAllStates(routeUpstreams) {
    const states = {};
    for (const upstream of routeUpstreams) {
      const key = this._key(upstream.url);
      const data = await this.redis.hgetall(key);
      states[upstream.url] = data ? data.state || STATES.CLOSED : STATES.CLOSED;
    }
    return states;
  }
}

function circuitBreakerPlugin(redis) {
  const breaker = new CircuitBreaker(redis);

  return {
    breaker,
    middleware: async (req, res, next, config) => {
      if (!config.enabled) return next();
      req.circuitBreaker = breaker;
      req.circuitBreakerConfig = config;
      next();
    },
  };
}

module.exports = { circuitBreakerPlugin, CircuitBreaker, STATES };
