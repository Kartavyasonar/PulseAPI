import { useState, useEffect } from 'react';

const GATEWAY = import.meta.env.VITE_GATEWAY_URL || 'http://localhost:3000';
const ADMIN_KEY = import.meta.env.VITE_ADMIN_KEY || 'admin-secret-key';

const headers = { 'X-Api-Key': ADMIN_KEY };

export function useAnalytics(refreshInterval = 10000) {
  const [analytics, setAnalytics] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [circuitBreakers, setCircuitBreakers] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function fetchAll() {
    try {
      const [analyticsRes, routesRes, cbRes] = await Promise.all([
        fetch(`${GATEWAY}/admin/analytics?window=1+hour`, { headers }),
        fetch(`${GATEWAY}/admin/routes`, { headers }),
        fetch(`${GATEWAY}/admin/circuit-breakers`, { headers }),
      ]);

      if (analyticsRes.ok) setAnalytics(await analyticsRes.json());
      if (routesRes.ok) setRoutes((await routesRes.json()).routes);
      if (cbRes.ok) setCircuitBreakers((await cbRes.json()).states);
      setLoading(false);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, refreshInterval);
    return () => clearInterval(interval);
  }, []);

  async function addRoute(route) {
    const res = await fetch(`${GATEWAY}/admin/routes`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(route),
    });
    const data = await res.json();
    if (res.ok) await fetchAll();
    return data;
  }

  async function deleteRoute(id) {
    await fetch(`${GATEWAY}/admin/routes/${id}`, { method: 'DELETE', headers });
    await fetchAll();
  }

  async function resetCircuitBreaker(upstream) {
    await fetch(`${GATEWAY}/admin/circuit-breakers/reset`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ upstream }),
    });
    await fetchAll();
  }

  async function getToken() {
    const res = await fetch(`${GATEWAY}/admin/token`, { method: 'POST', headers });
    return res.json();
  }

  return { analytics, routes, circuitBreakers, loading, error, addRoute, deleteRoute, resetCircuitBreaker, getToken, refresh: fetchAll };
}
