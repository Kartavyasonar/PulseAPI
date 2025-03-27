const { Router } = require('express');
const { generateTestToken } = require('../plugins/auth');

function adminRouter(db, routeManager, circuitBreaker, wsServer) {
  const router = Router();
  const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret-key';

  router.use((req, res, next) => {
    if (req.headers['x-api-key'] !== ADMIN_KEY) {
      return res.status(403).json({ error: 'admin access required' });
    }
    next();
  });

  router.get('/routes', (req, res) => {
    res.json({ routes: routeManager.list() });
  });

  router.post('/routes', async (req, res) => {
    try {
      const { id, pathPrefix, upstreams, plugins } = req.body;
      if (!id || !pathPrefix || !upstreams) {
        return res.status(400).json({ error: 'id, pathPrefix, and upstreams required' });
      }
      const defaults = {
        rateLimit:      { enabled: true,  requestsPerSecond: 10, burst: 20 },
        auth:           { enabled: false },
        retry:          { enabled: true,  maxRetries: 3, backoffMs: 100 },
        circuitBreaker: { enabled: true,  threshold: 5, resetTimeoutMs: 30000 },
      };
      const route = await routeManager.create(
        { id, pathPrefix, upstreams, plugins: { ...defaults, ...plugins } },
        db
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

  router.get('/analytics', async (req, res) => {
    try {
      const w = (req.query.window || '1 hour').replace(/[^a-z0-9 ]/gi, '');
      const [summary, topEndpoints, errorBreakdown, timeseries] = await Promise.all([
        db.query(`
          SELECT COUNT(*) total_requests,
            COUNT(*) FILTER (WHERE status_code >= 400) error_requests,
            ROUND(AVG(latency_ms)) avg_latency,
            PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms) p50,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) p95,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) p99
          FROM requests WHERE timestamp > NOW() - INTERVAL '${w}'`),
        db.query(`
          SELECT path, COUNT(*) count, ROUND(AVG(latency_ms)) avg_latency
          FROM requests WHERE timestamp > NOW() - INTERVAL '${w}'
          GROUP BY path ORDER BY count DESC LIMIT 10`),
        db.query(`
          SELECT status_code, COUNT(*) count
          FROM requests WHERE timestamp > NOW() - INTERVAL '${w}'
          GROUP BY status_code ORDER BY count DESC`),
        db.query(`
          SELECT date_trunc('minute', timestamp) minute,
            PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms) p50,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) p95,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) p99,
            COUNT(*) total, COUNT(*) FILTER (WHERE status_code >= 400) errors
          FROM requests WHERE timestamp > NOW() - INTERVAL '${w}'
          GROUP BY minute ORDER BY minute DESC LIMIT 60`),
      ]);
      res.json({ summary: summary.rows[0], topEndpoints: topEndpoints.rows, errorBreakdown: errorBreakdown.rows, latencyTimeseries: timeseries.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/circuit-breakers', async (req, res) => {
    const upstreams = routeManager.list().flatMap(r => r.upstreams);
    const states = await circuitBreaker.getAllStates(upstreams);
    res.json({ states });
  });

  router.post('/circuit-breakers/reset', async (req, res) => {
    const { upstream } = req.body;
    if (!upstream) return res.status(400).json({ error: 'upstream required' });
    await circuitBreaker.recordSuccess(upstream);
    res.json({ message: `reset: ${upstream}` });
  });

  router.post('/token', (req, res) => {
    const token = generateTestToken(req.body || {});
    res.json({ token, usage: 'Authorization: Bearer <token>' });
  });

  return router;
}

module.exports = { adminRouter };
