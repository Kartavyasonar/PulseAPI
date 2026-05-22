const { Router } = require('express');
const { generateTestToken } = require('../plugins/auth');
const crypto = require('crypto');

// whitelist prevents SQL injection via window param
const ALLOWED_WINDOWS = ['1 hour', '6 hours', '24 hours', '7 days', '30 days'];

function adminRouter(db, routeManager, circuitBreaker, wsServer) {
  const router = Router();
  const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret-key';

  router.use((req, res, next) => {
    if (req.headers['x-api-key'] !== ADMIN_KEY) {
      return res.status(403).json({ error: 'admin access required', hint: `X-Api-Key: ${ADMIN_KEY}` });
    }
    next();
  });

  // ── Routes ──────────────────────────────────────────────────────────────

  router.get('/routes', (req, res) => res.json({ routes: routeManager.list() }));

  router.post('/routes', async (req, res) => {
    try {
      const { id, pathPrefix, upstreams, plugins } = req.body;
      if (!id || !pathPrefix || !upstreams) {
        return res.status(400).json({ error: 'id, pathPrefix, upstreams required' });
      }
      const defaults = {
        rateLimit:      { enabled: true,  requestsPerSecond: 10, burst: 20, algorithm: 'token-bucket' },
        auth:           { enabled: false },
        retry:          { enabled: true,  maxRetries: 3, backoffMs: 100 },
        circuitBreaker: { enabled: true,  threshold: 5,  resetTimeoutMs: 30000 },
      };
      const route = await routeManager.create(
        { id, pathPrefix, upstreams, plugins: { ...defaults, ...plugins } }, db
      );
      wsServer.broadcast({ type: 'route_added', data: route });
      res.status(201).json({ route, message: 'created and hot-loaded — no restart required' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/routes/:id', async (req, res) => {
    await routeManager.delete(req.params.id, db);
    res.json({ message: `${req.params.id} deleted` });
  });

  // ── Analytics ────────────────────────────────────────────────────────────

  router.get('/analytics', async (req, res) => {
    // SECURITY: whitelist window to prevent SQL injection
    const safeWindow = ALLOWED_WINDOWS.includes(req.query.window) ? req.query.window : '1 hour';
    try {
      const [summary, topEndpoints, errorBreakdown, timeseries] = await Promise.all([
        db.query(`
          SELECT COUNT(*) total_requests,
            COUNT(*) FILTER (WHERE status_code >= 400) error_requests,
            ROUND(AVG(latency_ms)) avg_latency,
            PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms) p50,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) p95,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) p99
          FROM requests WHERE timestamp > NOW() - INTERVAL '${safeWindow}'`),
        db.query(`
          SELECT path, COUNT(*) count, ROUND(AVG(latency_ms)) avg_latency
          FROM requests WHERE timestamp > NOW() - INTERVAL '${safeWindow}'
          GROUP BY path ORDER BY count DESC LIMIT 10`),
        db.query(`
          SELECT status_code, COUNT(*) count
          FROM requests WHERE timestamp > NOW() - INTERVAL '${safeWindow}'
          GROUP BY status_code ORDER BY count DESC`),
        db.query(`
          SELECT date_trunc('minute', timestamp) AS bucket,
            PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms) p50,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) p95,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) p99,
            COUNT(*) total, COUNT(*) FILTER (WHERE status_code >= 400) errors
          FROM requests WHERE timestamp > NOW() - INTERVAL '${safeWindow}'
          GROUP BY bucket ORDER BY bucket DESC LIMIT 60`),
      ]);
      res.json({ summary: summary.rows[0], topEndpoints: topEndpoints.rows, errorBreakdown: errorBreakdown.rows, latencyTimeseries: timeseries.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Circuit Breakers ──────────────────────────────────────────────────────

  router.get('/circuit-breakers', async (req, res) => {
    const upstreams = routeManager.list().flatMap(r => r.upstreams);
    res.json({ states: await circuitBreaker.getAllStates(upstreams) });
  });

  router.post('/circuit-breakers/reset', async (req, res) => {
    const { upstream } = req.body;
    if (!upstream) return res.status(400).json({ error: 'upstream required' });
    await circuitBreaker.recordSuccess(upstream);
    res.json({ message: `reset: ${upstream}` });
  });

  // ── Tenants ───────────────────────────────────────────────────────────────

  router.get('/tenants', async (req, res) => {
    const result = await db.query(`
      SELECT t.id, t.name, t.tier, t.created_at,
        q.requests_per_second, q.requests_per_minute, q.requests_per_day,
        COUNT(k.key_hash) AS key_count
      FROM tenants t
      JOIN tenant_quota_config q ON q.tenant_id = t.id
      LEFT JOIN tenant_api_keys k ON k.tenant_id = t.id AND k.is_active = TRUE
      GROUP BY t.id, t.name, t.tier, t.created_at, q.requests_per_second, q.requests_per_minute, q.requests_per_day
      ORDER BY t.created_at
    `);
    res.json({ tenants: result.rows });
  });

  router.post('/tenants', async (req, res) => {
    const { id, name, tier = 'free' } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'id and name required' });
    const limits = { free: [10, 500, 50000], pro: [100, 5000, 500000], enterprise: [1000, 50000, 10000000] };
    const [rps, rpm, rpd] = limits[tier] || limits.free;
    await db.query('INSERT INTO tenants(id, name, tier) VALUES($1,$2,$3)', [id, name, tier]);
    await db.query('INSERT INTO tenant_quota_config(tenant_id,requests_per_second,requests_per_minute,requests_per_day) VALUES($1,$2,$3,$4)', [id, rps, rpm, rpd]);
    res.status(201).json({ tenant: { id, name, tier, requests_per_second: rps } });
  });

  router.get('/tenants/:id/usage', async (req, res) => {
    const { id } = req.params;
    const safeWindow = '24 hours';
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '1 hour') last_hour,
        COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '24 hours') last_day,
        COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '30 days') last_month,
        ROUND(AVG(latency_ms)) avg_latency,
        COUNT(*) FILTER (WHERE status_code >= 400 AND timestamp > NOW() - INTERVAL '24 hours') errors_day
      FROM requests WHERE tenant_id = $1
    `, [id]);
    res.json({ tenantId: id, usage: result.rows[0] });
  });

  router.post('/tenants/:id/keys', async (req, res) => {
    const { id } = req.params;
    const { name = 'api key' } = req.body;
    const rawKey  = `pk_${id}_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    await db.query(
      'INSERT INTO tenant_api_keys(key_hash, tenant_id, name) VALUES($1,$2,$3)',
      [keyHash, id, name]
    );
    // raw key returned ONCE — never stored
    res.status(201).json({ key: rawKey, hint: 'Store this — it will not be shown again' });
  });

  // ── Load Generator ────────────────────────────────────────────────────────
  // Spawns HTTP load against the gateway itself from inside the VM.
  // POST /admin/loadtest/start  { vus, duration, path }
  // POST /admin/loadtest/stop
  // GET  /admin/loadtest/status

  const { spawn } = require('child_process');
  let loadProc = null;
  let loadStats = { running: false, sent: 0, errors: 0, startedAt: null };

  router.post('/loadtest/start', (req, res) => {
    if (loadProc) return res.status(409).json({ error: 'load test already running — POST /admin/loadtest/stop first' });
    const vus      = Math.min(parseInt(req.body.vus      || 10),  50);
    const duration = Math.min(parseInt(req.body.duration || 30), 120);
    const path     = (req.body.path || '/api/test').replace(/[^a-zA-Z0-9/_-]/g, '');
    const url      = `http://localhost:3000${path}`;

    loadStats = { running: true, sent: 0, errors: 0, startedAt: Date.now(), vus, duration, path };

    // Use bash to run parallel curl workers for `duration` seconds
    const script = `
      end=$((SECONDS+${duration}))
      while [ $SECONDS -lt $end ]; do
        for i in $(seq 1 ${vus}); do
          curl -s -o /dev/null -w "%{http_code}\\n" ${url} &
        done
        wait
      done
    `;
    loadProc = spawn('bash', ['-c', script]);

    loadProc.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(code => {
        loadStats.sent++;
        if (parseInt(code) >= 400 || !code.match(/^\d+$/)) loadStats.errors++;
      });
      wsServer.broadcast({ type: 'loadtest', data: { ...loadStats } });
    });

    loadProc.on('close', () => {
      loadStats.running = false;
      loadProc = null;
      wsServer.broadcast({ type: 'loadtest', data: { ...loadStats } });
    });

    res.json({ message: `load test started`, vus, duration, path });
  });

  router.post('/loadtest/stop', (req, res) => {
    if (!loadProc) return res.json({ message: 'no load test running' });
    loadProc.kill('SIGTERM');
    loadProc = null;
    loadStats.running = false;
    res.json({ message: 'stopped', stats: loadStats });
  });

  router.get('/loadtest/status', (req, res) => {
    res.json(loadStats);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  router.post('/token', (req, res) => {
    const token = generateTestToken(req.body || {});
    res.json({ token, usage: 'Authorization: Bearer <token>' });
  });

  return router;
}

module.exports = { adminRouter };