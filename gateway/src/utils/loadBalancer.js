// Round-Robin Load Balancer
// simple, stateless (counter in memory is fine — slight imbalance on restart is ok)
// circuit-breaker-aware: skips OPEN upstreams

class LoadBalancer {
  constructor() {
    this.counters = new Map();
  }

  async selectUpstream(routeId, upstreams, circuitBreaker, cbConfig) {
    if (!upstreams || upstreams.length === 0) return null;

    // get CB states for all upstreams, skip OPEN ones
    let available = upstreams;
    if (circuitBreaker) {
      const states = await circuitBreaker.getAllStates(upstreams);
      available = upstreams.filter(u => states[u.url] !== 'open');
    }

    if (available.length === 0) return null;

    const idx = (this.counters.get(routeId) || 0) % available.length;
    this.counters.set(routeId, idx + 1);

    return { upstream: available[idx] };
  }
}

const balancer = new LoadBalancer();
module.exports = { LoadBalancer, balancer };
