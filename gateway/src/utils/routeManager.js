// Route Manager — loads from DB, supports hot reload via REST API
// Routes are cached in memory and refreshed on change

class RouteManager {
  constructor(db) {
    this.db = db;
    this.routes = new Map();
    this.loaded = false;
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
    this.loaded = true;
    console.log(`[RouteManager] Loaded ${this.routes.size} routes`);
    return this.routes;
  }

  // Match incoming path to a route (longest prefix wins)
  match(path) {
    let best = null;
    let bestLen = 0;
    for (const route of this.routes.values()) {
      if (path.startsWith(route.pathPrefix) && route.pathPrefix.length > bestLen) {
        best = route;
        bestLen = route.pathPrefix.length;
      }
    }
    return best;
  }

  async create(data, db) {
    const { id, pathPrefix, upstreams, plugins } = data;
    await db.query(
      `INSERT INTO routes (id, path_prefix, upstreams, plugins) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (id) DO UPDATE SET path_prefix=$2, upstreams=$3, plugins=$4, updated_at=NOW()`,
      [id, pathPrefix, JSON.stringify(upstreams), JSON.stringify(plugins)]
    );
    await this.load(); // Hot reload
    return this.routes.get(id);
  }

  async delete(id, db) {
    await db.query('DELETE FROM routes WHERE id=$1', [id]);
    this.routes.delete(id);
    return true;
  }

  list() {
    return Array.from(this.routes.values());
  }
}

module.exports = { RouteManager };
