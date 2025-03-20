// Request Logger — writes to PostgreSQL asynchronously
//
// buffered writes: collect entries for 500ms then batch INSERT
// this avoids adding DB latency to every proxied request
// trade-off: up to 500ms data loss on crash (acceptable for analytics)

class RequestLogger {
  constructor(db) {
    this.db = db;
    this.buffer = [];
    setInterval(() => this._flush(), 500);
  }

  log(entry) {
    this.buffer.push(entry);
  }

  async _flush() {
    if (!this.buffer.length) return;
    const entries = this.buffer.splice(0);
    try {
      const vals = entries.map((e, i) => {
        const b = i * 10;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10})`;
      });
      const params = entries.flatMap(e => [
        e.timestamp, e.method, e.path, e.routeId||null, e.upstream||null,
        e.clientIp||null, e.apiKey||null, e.status||null, e.latency||null, e.retries||0,
      ]);
      await this.db.query(
        `INSERT INTO requests(timestamp,method,path,route_id,upstream,client_ip,api_key,status_code,latency_ms,retries) VALUES ${vals.join(',')}`,
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
    req.log = { timestamp: new Date().toISOString(), method: req.method, path: req.path, clientIp: req.ip };
    res.on('finish', () => {
      req.log.latency = Date.now() - start;
      req.log.status  = req.log.status || res.statusCode;
      logger.log(req.log);
    });
    next();
  };
}

module.exports = { RequestLogger, loggerMiddleware };
