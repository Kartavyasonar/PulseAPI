// Rate Limiting — two algorithms, multi-tenant aware
//
// TokenBucket:    allows bursts, smooth refill, good for most APIs
// SlidingWindowLog: strict, no burst, higher Redis ops (2 commands vs 1 Lua)
//
// Multi-tenancy: if X-Api-Key present, look up tenant quota from DB
// Falls back to route-level config for anonymous/non-tenant requests

const crypto = require('crypto');

// ── Token Bucket ─────────────────────────────────────────────────────────

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
      if tokens == nil then tokens = burst; last_refill = now end
      local elapsed = (now - last_refill) / 1000.0
      local new_tokens = math.min(tokens + (elapsed * rate), burst)
      local allowed = 0; local retry_after = 0
      if new_tokens >= 1 then
        new_tokens = new_tokens - 1; allowed = 1
      else
        retry_after = math.ceil((1 - new_tokens) / rate * 1000)
      end
      redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
      redis.call('EXPIRE', key, ttl)
      return {allowed, math.floor(new_tokens), retry_after}
    `;
    const r = await this.redis.eval(script, 1, `rl:tb:${key}`, now, requestsPerSecond, burst);
    return { allowed: r[0] === 1, remainingTokens: r[1], retryAfter: r[2], algorithm: 'token-bucket' };
  }
}

// ── Sliding Window Log ────────────────────────────────────────────────────
// Uses Redis sorted set: members = request timestamps, score = timestamp
// Atomic via Lua: remove stale, count, conditionally add

class SlidingWindowLog {
  constructor(redis) {
    this.redis = redis;
  }

  async consume(key, requestsPerSecond, windowMs = 1000) {
    const now = Date.now();
    const windowStart = now - windowMs;
    const limit = requestsPerSecond;

    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local window_start = tonumber(ARGV[2])
      local limit = tonumber(ARGV[3])
      local ttl = math.ceil(tonumber(ARGV[4]) / 1000) + 5
      redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
      local count = redis.call('ZCARD', key)
      local allowed = 0; local retry_after = 0
      if count < limit then
        redis.call('ZADD', key, now, now .. ':' .. math.random(100000))
        redis.call('EXPIRE', key, ttl)
        allowed = 1
      else
        local oldest = tonumber(redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2] or 0)
        retry_after = math.max(0, oldest + tonumber(ARGV[4]) - now)
      end
      return {allowed, limit - count - (allowed == 1 and 1 or 0), retry_after}
    `;
    const r = await this.redis.eval(script, 1, `rl:sw:${key}`, now, windowStart, limit, windowMs);
    return { allowed: r[0] === 1, remainingTokens: Math.max(0, r[1]), retryAfter: r[2], algorithm: 'sliding-window' };
  }
}

// ── Tenant resolver ───────────────────────────────────────────────────────

async function resolveTenant(apiKey, db) {
  if (!apiKey || !db) return null;
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const result = await db.query(`
    SELECT t.id AS tenant_id, t.tier, q.requests_per_second, q.requests_per_minute, q.requests_per_day
    FROM tenant_api_keys k
    JOIN tenants t ON t.id = k.tenant_id
    JOIN tenant_quota_config q ON q.tenant_id = t.id
    WHERE k.key_hash = $1 AND k.is_active = TRUE
  `, [keyHash]);
  return result.rows[0] || null;
}

// ── Plugin factory ────────────────────────────────────────────────────────

function rateLimitPlugin(redis, db) {
  const tokenBucket     = new TokenBucket(redis);
  const slidingWindow   = new SlidingWindowLog(redis);

  return async (req, res, next, config) => {
    if (!config || !config.enabled) return next();

    const { requestsPerSecond = 10, burst: configBurst = 20, algorithm = 'token-bucket' } = config;
    let rps        = requestsPerSecond;
    let burstLimit = configBurst;
    let rlKey;

    // try to resolve tenant from API key
    const rawKey = req.headers['x-api-key'];
    if (rawKey) {
      const tenant = await resolveTenant(rawKey, db).catch(() => null);
      if (tenant) {
        rps        = tenant.requests_per_second;
        burstLimit = Math.min(rps * 2, 2000);
        rlKey  = `tenant:${tenant.tenant_id}:${req.routeId}`;
        req.tenantId = tenant.tenant_id;
        req.log.tenantId = tenant.tenant_id;
      }
    }

    if (!rlKey) {
      rlKey = `ip:${req.clientIp || req.ip}:${req.routeId}`;
    }

    const result = algorithm === 'sliding-window'
      ? await slidingWindow.consume(rlKey, rps, 1000)
      : await tokenBucket.consume(rlKey, rps, burstLimit);

    res.setHeader('X-RateLimit-Limit',     rps);
    res.setHeader('X-RateLimit-Remaining', result.remainingTokens);
    res.setHeader('X-RateLimit-Algorithm', result.algorithm);

    if (!result.allowed) {
      res.setHeader('Retry-After', Math.ceil(result.retryAfter / 1000));
      req.log.status = 429;
      return res.status(429).json({
        error: 'rate limit exceeded',
        algorithm: result.algorithm,
        retryAfterMs: result.retryAfter,
      });
    }

    next();
  };
}

module.exports = { rateLimitPlugin, TokenBucket, SlidingWindowLog, resolveTenant };
