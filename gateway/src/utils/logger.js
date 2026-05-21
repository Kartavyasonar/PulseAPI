// Request Logger — publishes to Kafka (if available) or writes directly to
// PostgreSQL. Broadcasts live events via WebSocket regardless of backend.
//
// Kafka path  → entries published to 'request-logs' topic; kafka-consumer/
//               subscribes and batch-inserts to Postgres. Gateway latency is
//               fully decoupled from DB write throughput.
// Postgres path → legacy 500ms-buffered batch INSERT; used when Kafka is
//               not configured (local dev, test env).

let getCurrentTraceId;
try {
  ({ getCurrentTraceId } = require('../tracing'));
} catch {
  getCurrentTraceId = () => null; // tracing not available in test env
}

const { kafkaLogger } = require('./kafkaLogger');

class RequestLogger {
  constructor(db, wsServer) {
    this.db = db;
    this.wsServer = wsServer;
    // buffer used only for the Postgres fallback path
    this.buffer = [];
    setInterval(() => this._flush(), 500);
  }

  log(entry) {
    entry.traceId = entry.traceId || getCurrentTraceId();
    // Always broadcast to WebSocket dashboard — Kafka is the storage path only
    if (this.wsServer) {
      this.wsServer.broadcast({ type: 'request', data: entry });
    }
    // Try Kafka first; buffer for Postgres if not ready
    kafkaLogger.publish(entry).then(published => {
      if (!published) this.buffer.push(entry);
    }).catch(() => {
      this.buffer.push(entry);
    });
  }

  // Postgres fallback flush — only drains when Kafka is unavailable
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
      console.error('[logger] postgres flush error:', err.message);
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
