// first pass: in-memory rate limiter — won't work across multiple instances
// switching to Redis token bucket once I get redis wired up

const counters = new Map();

function rateLimitMiddleware(requestsPerSecond = 10) {
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const window = 1000; // 1 second

    const bucket = counters.get(key) || { count: 0, windowStart: now };

    if (now - bucket.windowStart > window) {
      bucket.count = 0;
      bucket.windowStart = now;
    }

    bucket.count++;
    counters.set(key, bucket);

    if (bucket.count > requestsPerSecond) {
      return res.status(429).json({ error: 'rate limit exceeded' });
    }

    next();
  };
}

module.exports = { rateLimitMiddleware };
