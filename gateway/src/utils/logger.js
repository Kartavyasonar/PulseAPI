// Request Logger — logs to PostgreSQL and broadcasts to WebSocket clients
// Async fire-and-forget to avoid adding latency

class RequestLogger {
  constructor(db, wsServer) {
    this.db = db;
    this.wsServer = wsServer;
    this.buffer = [];
    this.flushInterval = 500; // flush every 500ms
    this._startFlush();
  }

  _startFlush() {
    setInterval(() => this._flush(), this.flushInterval);
  }

  log(entry) {
    this.buffer.push(entry);
    // Broadcast to WebSocket clients immediately for real-time feel
    if (this.wsServer) {
      this.wsServer.broadcast({
        type: 'request',
        data: entry,
      });
    }
  }

  async _flush() {
    if (this.buffer.length === 0) return;
    const entries = this.buffer.splice(0);

    try {
      const values = entries.map((e, i) => {
        const base = i * 11;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
      });

      const params = entries.flatMap((e) => [
        e.timestamp,
        e.method,
        e.path,
        e.routeId || null,
        e.upstream || null,
        e.clientIp || null,
        e.apiKey || null,
        e.status || null,
        e.latency || null,
        e.retries || 0,
        e.error || null,
      ]);

      await this.db.query(
        `INSERT INTO requests (timestamp, method, path, route_id, upstream, client_ip, api_key, status_code, latency_ms, retries, error)
         VALUES ${values.join(',')}`,
        params
      );
    } catch (err) {
      console.error('[Logger] Flush error:', err.message);
    }
  }
}

function loggerMiddleware(logger) {
  return (req, res, next) => {
    const start = Date.now();

    // Attach log object that plugins can mutate
    req.log = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      clientIp: req.ip || req.connection.remoteAddress,
    };

    res.on('finish', () => {
      req.log.latency = Date.now() - start;
      req.log.status = req.log.status || res.statusCode;
      logger.log(req.log);
    });

    next();
  };
}

module.exports = { RequestLogger, loggerMiddleware };
