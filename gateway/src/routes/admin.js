const { Router } = require('express');
const { generateTestToken } = require('../plugins/auth');

function adminRouter(db, routeManager, circuitBreaker, wsServer) {
  const router = Router();

  const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret-key';

  // Admin auth middleware
  router.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Admin access required', hint: `Use X-Api-Key: ${ADMIN_KEY}` });
    }
    next();
  });

  // GET /admin/routes — list all routes
  router.get('/routes', (req, res) => {
    res.json({ routes: routeManager.list() });
  });

  // POST /admin/routes — create/update route (hot reload, no restart)
  router.post('/routes', async (req, res) => {
    try {
      const { id, pathPrefix, upstreams, plugins } = req.body;
      if (!id || !pathPrefix || !upstreams) {
        return res.status(400).json({ error: 'id, pathPrefix, and upstreams are required' });
      }

      const defaultPlugins = {
        rateLimit: { enabled: true, requestsPerSecond: 10, burst: 20 },
        auth: { enabled: false },
        retry: { enabled: true, maxRetries: 3, backoffMs: 100 },
        circuitBreaker: { enabled: true, threshold: 5, resetTimeoutMs: 30000 },
        ...plugins,
      };

      const route = await routeManager.create({ id, pathPrefix, upstreams, plugins: defaultPlugins }, db);
      wsServer.broadcast({ type: 'route_added', data: route });
      res.status(201).json({ route, message: 'Route created and hot-loaded — no restart required' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /admin/routes/:id
  router.delete('/routes/:id', async (req, res) => {
    try {
      await routeManager.delete(req.params.id, db);
      res.json({ message: `Route ${req.params.id} deleted and hot-removed` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /admin/analytics — live analytics from DB
  router.get('/analytics', async (req, res) => {
    try {
      const window = req.query.window || '1 hour';
      const [summary, topEndpoints, errorBreakdown, latencyPercentiles] = await Promise.all([
        db.query(`
          SELECT 
            COUNT(*) total_requests,
            COUNT(*) FILTER (WHERE status_code >= 400) error_requests,
            ROUND(AVG(latency_ms)) avg_latency,
            ROUND(AVG(latency_ms) FILTER (WHERE timestamp > NOW() - INTERVAL '1 minute')) rps_window_avg,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) p50,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) p95,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) p99
          FROM requests WHERE timestamp > NOW() - INTERVAL '${window}'
        `),
        db.query(`
          SELECT path, COUNT(*) count, ROUND(AVG(latency_ms)) avg_latency
          FROM requests 
          WHERE timestamp > NOW() - INTERVAL '${window}'
          GROUP BY path ORDER BY count DESC LIMIT 10
        `),
        db.query(`
          SELECT status_code, COUNT(*) count
          FROM requests 
          WHERE timestamp > NOW() - INTERVAL '${window}'
          GROUP BY status_code ORDER BY count DESC
        `),
        db.query(`
          SELECT 
            date_trunc('minute', timestamp) minute,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) p50,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) p95,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) p99,
            COUNT(*) total,
            COUNT(*) FILTER (WHERE status_code >= 400) errors
          FROM requests
          WHERE timestamp > NOW() - INTERVAL '${window}'
          GROUP BY minute ORDER BY minute DESC LIMIT 60
        `),
      ]);

      res.json({
        summary: summary.rows[0],
        topEndpoints: topEndpoints.rows,
        errorBreakdown: errorBreakdown.rows,
        latencyTimeseries: latencyPercentiles.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /admin/circuit-breakers
  router.get('/circuit-breakers', async (req, res) => {
    try {
      const routes = routeManager.list();
      const allUpstreams = routes.flatMap((r) => r.upstreams);
      const states = await circuitBreaker.getAllStates(allUpstreams);
      res.json({ states });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /admin/circuit-breakers/:upstream/reset
  router.post('/circuit-breakers/reset', async (req, res) => {
    const { upstream } = req.body;
    if (!upstream) return res.status(400).json({ error: 'upstream URL required' });
    await circuitBreaker.recordSuccess(upstream);
    res.json({ message: `Circuit breaker reset for ${upstream}` });
  });

  // POST /admin/token — generate test JWT
  router.post('/token', (req, res) => {
    const token = generateTestToken(req.body || {});
    res.json({ token, usage: 'Authorization: Bearer <token>' });
  });

  return router;
}

module.exports = { adminRouter };
