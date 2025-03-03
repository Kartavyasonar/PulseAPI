// Token Bucket Rate Limiter — implemented from scratch
// Each client gets a bucket with `burst` tokens, refilled at `requestsPerSecond` rate
// Redis stores: [tokens, lastRefillTimestamp]

class TokenBucket {
  constructor(redis) {
    this.redis = redis;
  }

  async consume(key, requestsPerSecond, burst) {
    const now = Date.now();
    const bucketKey = `rl:tb:${key}`;

    // Lua script for atomic token bucket operation
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

      -- Refill tokens based on elapsed time
      local elapsed = (now - last_refill) / 1000.0
      local new_tokens = tokens + (elapsed * rate)
      if new_tokens > burst then new_tokens = burst end

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

    const result = await this.redis.eval(script, 1, bucketKey, now, requestsPerSecond, burst);
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
    if (!config.enabled) return next();

    const { requestsPerSecond = 10, burst = 20 } = config;

    // Key by API key if present, else by IP
    const clientKey = req.apiKey || req.clientIp;
    const routeKey = `${req.routeId}:${clientKey}`;

    const result = await bucket.consume(routeKey, requestsPerSecond, burst);

    res.setHeader('X-RateLimit-Limit', requestsPerSecond);
    res.setHeader('X-RateLimit-Remaining', result.remainingTokens);
    res.setHeader('X-RateLimit-Algorithm', 'token-bucket');

    if (!result.allowed) {
      res.setHeader('Retry-After', Math.ceil(result.retryAfter / 1000));
      req.log.status = 429;
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfterMs: result.retryAfter,
        algorithm: 'token-bucket',
      });
    }

    next();
  };
}

module.exports = { rateLimitPlugin, TokenBucket };
