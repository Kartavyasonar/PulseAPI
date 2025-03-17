// Circuit Breaker — first pass
// state machine: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
//
// CLOSED:    normal operation, count failures
// OPEN:      reject all requests immediately, return 503
// HALF_OPEN: allow one probe request through, if it succeeds -> CLOSED
//
// storing state in Redis so all gateway instances share it

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

    // check if OPEN long enough to try HALF_OPEN
    if (data.state === STATES.OPEN) {
      const elapsed = Date.now() - parseInt(data.opened_at || 0);
      if (elapsed > config.resetTimeoutMs) {
        await this.redis.hset(key, 'state', STATES.HALF_OPEN);
        return { state: STATES.HALF_OPEN, failures: parseInt(data.failures || 0) };
      }
    }

    return { state: data.state, failures: parseInt(data.failures || 0) };
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
    const states = {};
    for (const u of upstreams) {
      const d = await this.redis.hgetall(this._key(u.url));
      states[u.url] = d ? (d.state || STATES.CLOSED) : STATES.CLOSED;
    }
    return states;
  }
}

module.exports = { CircuitBreaker, STATES };
