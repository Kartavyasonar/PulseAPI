// Request Logger — writes to PostgreSQL, broadcasts via WebSocket
// buffered writes (500ms) to keep logger off the critical path

let getCurrentTraceId;
try {
  ({ getCurrentTraceId } = require('../tracing'));
} catch {
  getCurrentTraceId = () => null; // tracing not available in test env
}

class RequestLogger {
  constructor(db, wsServer) {
    this.db = db;
    this.wsServer = wsServer;
    this.buffer = [];
    setInterval(() => this._flush(), 500);
  }

  log(entry) {
    // attach active trace ID if available
    entry.traceId = entry.traceId || getCurrentTraceId();
    this.buffer.push(entry);
    if (this.wsServer) {
      this.wsServer.broadcast({ type: 'request', data: entry });
    }
  }

  async _flush() {
    if (!this.buffer.length) return;
    const entries = this.buffer.splice(0);
    try {
      const vals = entries.map((_, i) => {
        const b = i * 11;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`;
      });
      const params = entries.flatMap(e => [
        e.timestamp, e.method, e.path, e.routeId||null, e.upstream||null,
        e.clientIp||null, e.apiKey||null, e.tenantId||null,
        e.status||null, e.latency||null, e.traceId||null,
      ]);
      await this.db.query(
        `INSERT INTO requests(timestamp,method,path,route_id,upstream,client_ip,api_key,tenant_id,status_code,latency_ms,trace_id)
         VALUES ${vals.join(',')}`,
        params
      );
    } catch (err) {
      console.error('[logger] flush error:', err.message);
    }
  }
}

function loggerMiddleware(logger) {
  return (req, res, next) => {
    const start = Date.now();
    req.log = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      clientIp: req.ip,
    };
    res.on('finish', () => {
      req.log.latency = Date.now() - start;
      req.log.status  = req.log.status || res.statusCode;
      logger.log(req.log);
    });
    next();
  };
}

module.exports = { RequestLogger, loggerMiddleware };
