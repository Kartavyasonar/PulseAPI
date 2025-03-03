// Round-Robin Load Balancer with circuit breaker awareness
// Skips OPEN circuit upstreams, falls back to any available

const { STATES } = require('../plugins/circuitBreaker');

class LoadBalancer {
  constructor() {
    this.counters = new Map(); // routeId -> current index
  }

  async selectUpstream(routeId, upstreams, circuitBreaker, cbConfig) {
    if (!upstreams || upstreams.length === 0) return null;

    // Check circuit breaker states for all upstreams
    const states = circuitBreaker
      ? await circuitBreaker.getAllStates(upstreams)
      : {};

    // Filter to available upstreams (CLOSED or HALF_OPEN)
    const available = upstreams.filter(
      (u) => states[u.url] !== STATES.OPEN
    );

    if (available.length === 0) {
      return null; // All circuits open
    }

    // Round-robin across available upstreams
    const counter = this.counters.get(routeId) || 0;
    const selected = available[counter % available.length];
    this.counters.set(routeId, counter + 1);

    return { upstream: selected, state: states[selected.url] || STATES.CLOSED };
  }
}

const balancer = new LoadBalancer();

module.exports = { LoadBalancer, balancer };
