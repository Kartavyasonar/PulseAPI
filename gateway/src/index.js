// tracing MUST be first — OTel patches http/express on require
require('./tracing');

require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Pool } = require('pg');
const Redis   = require('ioredis');

const { RouteManager }                   = require('./utils/routeManager');
const { RequestLogger, loggerMiddleware }= require('./utils/logger');
const { WsServer }                       = require('./utils/wsServer');
const { rateLimitPlugin }                = require('./plugins/rateLimit');
const { circuitBreakerPlugin }           = require('./plugins/circuitBreaker');
const { authPlugin }                     = require('./plugins/auth');
const { balancer }                       = require('./utils/loadBalancer');
const { proxyRequest }                   = require('./utils/proxy');
const { adminRouter }                    = require('./routes/admin');

async function start() {
  const db = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://pulse:pulse@localhost:5432/pulseapi',
    max: 20,
  });
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true });
  await redis.connect().catch(console.error);
  await db.query('SELECT 1').catch(console.error);

  const app    = express();
  const server = http.createServer(app);
  const ws     = new WsServer();
  ws.attach(server);

  const routeManager = new RouteManager(db);
  await routeManager.load();

  const logger = new RequestLogger(db, ws);

  // pass db to rateLimitPlugin for tenant resolution
  const rateLimit = rateLimitPlugin(redis, db);
  const cbPlugin  = circuitBreakerPlugin(redis);
  const auth      = authPlugin();

  app.use(express.json());
  app.use(loggerMiddleware(logger));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Api-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    req.clientIp = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    next();
  });

  app.use('/admin', adminRouter(db, routeManager, cbPlugin.breaker, ws));

  app.get('/health', async (req, res) => {
    const [dbOk, redisOk] = await Promise.all([
      db.query('SELECT 1').then(() => true).catch(() => false),
      redis.ping().then(()  => true).catch(() => false),
    ]);
    res.json({ status: dbOk && redisOk ? 'ok' : 'degraded', db: dbOk, redis: redisOk, routes: routeManager.list().length, uptime: process.uptime() });
  });

  app.all('*', async (req, res) => {
    const route = routeManager.match(req.path);
    if (!route) return res.status(404).json({ error: 'no route matched', path: req.path, hint: 'POST /admin/routes to add a route' });

    req.routeId      = route.id;
    req.log.routeId  = route.id;
    const plugins    = route.plugins;

    const runPlugin = (fn, cfg) => new Promise(resolve => fn(req, res, resolve, cfg));

    await runPlugin(rateLimit, plugins.rateLimit);
    if (res.headersSent) return;

    await runPlugin(auth, plugins.auth);
    if (res.headersSent) return;

    await runPlugin(cbPlugin.middleware, plugins.circuitBreaker);
    if (res.headersSent) return;

    const sel = await balancer.selectUpstream(route.id, route.upstreams, req.circuitBreaker, plugins.circuitBreaker);
    if (!sel) {
      req.log.status = 503;
      ws.broadcast({ type: 'circuit_open', routeId: route.id });
      return res.status(503).json({ error: 'all upstreams unavailable', retryAfter: 30 });
    }

    req.log.upstream = sel.upstream.url;
    const result = await proxyRequest(req, res, sel.upstream, route, req.circuitBreaker);
    req.log.retries = result.retries || 0;
    req.log.status  = result.status;

    if (result.circuitOpen) return res.status(503).json({ error: result.error });
    if (result.error && !result.body) return res.status(result.status || 502).json({ error: result.error });

    if (result.headers) {
      Object.entries(result.headers).forEach(([k,v]) => { try { res.setHeader(k,v); } catch {} });
    }
    res.setHeader('X-Gateway',  'PulseAPI/1.0');
    res.setHeader('X-Route-Id', route.id);
    res.setHeader('X-Retries',  result.retries || 0);
    res.status(result.status || 200).send(result.body);
  });

  setInterval(async () => {
    try {
      const r = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '1 second') rps,
          ROUND(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms)) FILTER (WHERE timestamp > NOW() - INTERVAL '1 minute') p50,
          ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)) FILTER (WHERE timestamp > NOW() - INTERVAL '1 minute') p95,
          ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms)) FILTER (WHERE timestamp > NOW() - INTERVAL '1 minute') p99,
          COUNT(*) FILTER (WHERE status_code >= 400 AND timestamp > NOW() - INTERVAL '1 minute') errors_1m
        FROM requests WHERE timestamp > NOW() - INTERVAL '1 minute'`);
      ws.broadcastStats({ ...r.rows[0], timestamp: Date.now() });
    } catch {}
  }, 1000);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n⚡ PulseAPI running on :${PORT}`);
    console.log(`   admin:  http://localhost:${PORT}/admin  (X-Api-Key: ${process.env.ADMIN_KEY || 'admin-secret-key'})`);
    console.log(`   ws:     ws://localhost:${PORT}/ws`);
    console.log(`   traces: http://localhost:16686\n`);
  });

  process.on('SIGTERM', async () => { server.close(); await db.end(); redis.disconnect(); });
}

start().catch(err => { console.error('fatal:', err); process.exit(1); });
