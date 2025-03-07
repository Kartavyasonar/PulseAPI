// Route Manager — in-memory route table loaded from config
// will add DB persistence + hot reload later

class RouteManager {
  constructor() {
    this.routes = new Map();
  }

  load(routesArray) {
    this.routes.clear();
    for (const r of routesArray) {
      this.routes.set(r.id, r);
    }
    console.log(`[RouteManager] loaded ${this.routes.size} routes`);
  }

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

  list() {
    return Array.from(this.routes.values());
  }
}

module.exports = { RouteManager };
