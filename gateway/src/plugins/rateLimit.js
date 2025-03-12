// Token Bucket Rate Limiter using Redis
//
// Why token bucket over sliding window?
// - handles bursts naturally (accumulated tokens)
// - fairer than fixed windows (no thundering herd at window reset)
// - single Lua script = atomic, no race conditions
//
// bucket state: { tokens: float, last_refill: timestamp_ms }

class TokenBucket {
  constructor(redis) {
    this.redis = redis;
  }

  async consume(key, requestsPerSecond, burst) {
    const now = Date.now();

    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local rate = tonumber(ARGV[2])
      local burst = tonumber(ARGV[3])
      local ttl = math.ceil(burst / rate) + 10

      local data = redis.call('HMGET', key, 'tokens', 'last_refill')
      local tokens = tonumber(data[1])
      local last_refill = tonumber(data[2])

      if tokens == nil then
        tokens = burst
        last_refill = now
      end

      local elapsed = (now - last_refill) / 1000.0
      local new_tokens = math.min(tokens + (elapsed * rate), burst)

      local allowed = 0
      local retry_after = 0

      if new_tokens >= 1 then
        new_tokens = new_tokens - 1
        allowed = 1
      else
        retry_after = math.ceil((1 - new_tokens) / rate * 1000)
      end

      redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
      redis.call('EXPIRE', key, ttl)

      return {allowed, math.floor(new_tokens), retry_after}
    `;

    const result = await this.redis.eval(script, 1, `rl:tb:${key}`, now, requestsPerSecond, burst);
    return {
      allowed: result[0] === 1,
      remainingTokens: result[1],
      retryAfter: result[2],
    };
  }
}

function rateLimitPlugin(redis) {
  const bucket = new TokenBucket(redis);

  return async (req, res, next, config) => {
    if (!config || !config.enabled) return next();

    const { requestsPerSecond = 10, burst = 20 } = config;
    const clientKey = req.apiKey || req.clientIp || req.ip;
    const routeKey = `${req.routeId}:${clientKey}`;

    const result = await bucket.consume(routeKey, requestsPerSecond, burst);

    res.setHeader('X-RateLimit-Limit', requestsPerSecond);
    res.setHeader('X-RateLimit-Remaining', result.remainingTokens);

    if (!result.allowed) {
      res.setHeader('Retry-After', Math.ceil(result.retryAfter / 1000));
      return res.status(429).json({
        error: 'rate limit exceeded',
        retryAfterMs: result.retryAfter,
      });
    }

    next();
  };
}

module.exports = { rateLimitPlugin, TokenBucket };
