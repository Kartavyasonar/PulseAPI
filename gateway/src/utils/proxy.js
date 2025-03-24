const http  = require('http');
const https = require('https');
const { STATES } = require('../plugins/circuitBreaker');

// retry with exponential backoff
// attempt 0: immediate
// attempt 1: backoffMs * 2^0
// attempt 2: backoffMs * 2^1
// ...

async function proxyRequest(req, res, upstream, routeConfig, circuitBreaker) {
  const { retry: rc, circuitBreaker: cbc } = routeConfig.plugins;
  const maxRetries = rc?.enabled ? (rc.maxRetries || 3) : 0;
  const backoffMs  = rc?.backoffMs || 100;

  let attempts = 0;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt;

    if (circuitBreaker && cbc?.enabled) {
      const s = await circuitBreaker.getState(upstream.url, cbc);
      if (s.state === STATES.OPEN) {
        return { status: 503, error: `circuit open: ${upstream.url}`, circuitOpen: true, retries: attempts };
      }
    }

    try {
      const result = await _forward(req, upstream.url, routeConfig);

      if (result.status >= 500 && attempt < maxRetries) {
        if (circuitBreaker && cbc?.enabled) await circuitBreaker.recordFailure(upstream.url, cbc);
        lastError = new Error(`upstream ${result.status}`);
        await _sleep(backoffMs * Math.pow(2, attempt));
        continue;
      }

      if (circuitBreaker && cbc?.enabled && result.status < 500) {
        await circuitBreaker.recordSuccess(upstream.url);
      }

      return { ...result, retries: attempts };
    } catch (err) {
      lastError = err;
      if (circuitBreaker && cbc?.enabled) await circuitBreaker.recordFailure(upstream.url, cbc);
      if (attempt < maxRetries) await _sleep(backoffMs * Math.pow(2, attempt));
    }
  }

  return { status: 502, error: lastError?.message || 'upstream unreachable', retries: attempts };
}

function _forward(req, upstreamUrl, routeConfig) {
  return new Promise((resolve, reject) => {
    const t = new URL(upstreamUrl);
    const strippedPath = req.originalUrl.replace(new RegExp(`^${routeConfig.pathPrefix}`), '') || '/';

    const opts = {
      hostname: t.hostname,
      port: t.port || (t.protocol === 'https:' ? 443 : 80),
      path: strippedPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: t.host,
        'x-forwarded-for': req.ip || '',
        'x-gateway': 'pulseapi/1.0',
      },
      timeout: 10000,
    };
    delete opts.headers['connection'];
    delete opts.headers['keep-alive'];

    const lib = t.protocol === 'https:' ? https : http;
    const pReq = lib.request(opts, pRes => {
      const chunks = [];
      pRes.on('data', c => chunks.push(c));
      pRes.on('end',  () => {
        const headers = { ...pRes.headers };
        delete headers['transfer-encoding'];
        resolve({ status: pRes.statusCode, headers, body: Buffer.concat(chunks) });
      });
    });

    pReq.on('error', reject);
    pReq.on('timeout', () => { pReq.destroy(); reject(new Error('upstream timeout')); });

    if (['POST','PUT','PATCH'].includes(req.method)) req.pipe(pReq);
    else pReq.end();
  });
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { proxyRequest };
