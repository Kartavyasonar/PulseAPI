// Route Manager — loads from PostgreSQL, supports hot reload via REST API
// routes cached in memory for zero-latency matching on hot path

class RouteManager {
  constructor(db) {
    this.db = db;
    this.routes = new Map();
  }

  async load() {
    const result = await this.db.query(
      'SELECT id, path_prefix, upstreams, plugins FROM routes ORDER BY LENGTH(path_prefix) DESC'
    );
    this.routes.clear();
    for (const row of result.rows) {
      this.routes.set(row.id, {
        id: row.id,
        pathPrefix: row.path_prefix,
        upstreams: row.upstreams,
        plugins: row.plugins,
      });
    }
    console.log(`[RouteManager] loaded ${this.routes.size} routes from DB`);
  }

  match(path) {
    let best = null, bestLen = 0;
    for (const r of this.routes.values()) {
      if (path.startsWith(r.pathPrefix) && r.pathPrefix.length > bestLen) {
        best = r; bestLen = r.pathPrefix.length;
      }
    }
    return best;
  }

  async create(data, db) {
    const { id, pathPrefix, upstreams, plugins } = data;
    await db.query(
      `INSERT INTO routes(id, path_prefix, upstreams, plugins)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(id) DO UPDATE SET path_prefix=$2, upstreams=$3, plugins=$4, updated_at=NOW()`,
      [id, pathPrefix, JSON.stringify(upstreams), JSON.stringify(plugins)]
    );
    await this.load(); // hot reload: refresh in-memory table immediately
    return this.routes.get(id);
  }

  async delete(id, db) {
    await db.query('DELETE FROM routes WHERE id=$1', [id]);
    this.routes.delete(id);
  }

  list() { return Array.from(this.routes.values()); }
}

module.exports = { RouteManager };
