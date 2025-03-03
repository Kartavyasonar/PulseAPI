const http = require('http');
const https = require('https');
const { STATES } = require('../plugins/circuitBreaker');

// Custom proxy with retry + exponential backoff + circuit breaker
async function proxyRequest(req, res, upstream, routeConfig, circuitBreaker) {
  const { retry: retryConfig, circuitBreaker: cbConfig } = routeConfig.plugins;
  const maxRetries = retryConfig?.enabled ? (retryConfig.maxRetries || 3) : 0;
  const backoffMs = retryConfig?.backoffMs || 100;

  let lastError;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt;

    // Check circuit breaker before each attempt
    if (circuitBreaker && cbConfig?.enabled) {
      const cbState = await circuitBreaker.getState(upstream.url, cbConfig);
      if (cbState.state === STATES.OPEN) {
        return {
          status: 503,
          error: `Circuit breaker OPEN for ${upstream.url}`,
          circuitOpen: true,
          retries: attempts,
        };
      }
    }

    try {
      const result = await forwardRequest(req, upstream.url, routeConfig);

      if (result.status >= 500 && attempt < maxRetries) {
        // Record failure and retry
        if (circuitBreaker && cbConfig?.enabled) {
          await circuitBreaker.recordFailure(upstream.url, cbConfig);
        }
        lastError = new Error(`Upstream returned ${result.status}`);
        await sleep(backoffMs * Math.pow(2, attempt)); // exponential backoff
        continue;
      }

      // Success — record it
      if (circuitBreaker && cbConfig?.enabled) {
        if (result.status < 500) {
          await circuitBreaker.recordSuccess(upstream.url);
        }
      }

      return { ...result, retries: attempts };
    } catch (err) {
      lastError = err;
      if (circuitBreaker && cbConfig?.enabled) {
        await circuitBreaker.recordFailure(upstream.url, cbConfig);
      }
      if (attempt < maxRetries) {
        await sleep(backoffMs * Math.pow(2, attempt));
      }
    }
  }

  return {
    status: 502,
    error: lastError?.message || 'Upstream unreachable',
    retries: attempts,
  };
}

function forwardRequest(req, upstreamUrl, routeConfig) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(upstreamUrl);
    const pathPrefix = routeConfig.pathPrefix;

    // Rewrite path: strip route prefix
    const upstreamPath = req.originalUrl.replace(new RegExp(`^${pathPrefix}`), '') || '/';

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: upstreamPath || '/',
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.host,
        'x-forwarded-for': req.ip || '',
        'x-forwarded-proto': 'http',
        'x-gateway': 'pulseapi/1.0',
      },
      timeout: 10000,
    };

    // Remove hop-by-hop headers
    delete options.headers['connection'];
    delete options.headers['keep-alive'];

    const proto = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = proto.request(options, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks);

        // Forward response headers
        res_headers = { ...proxyRes.headers };
        delete res_headers['transfer-encoding'];

        resolve({
          status: proxyRes.statusCode,
          headers: res_headers,
          body,
        });
      });
    });

    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      reject(new Error('Upstream timeout'));
    });

    // Forward request body
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { proxyRequest };
