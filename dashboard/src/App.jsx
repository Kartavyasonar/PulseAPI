import React, { useState, useEffect, useRef } from 'react';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { useWebSocket } from './hooks/useWebSocket';
import { useAnalytics } from './hooks/useAnalytics';

const GATEWAY_WS = import.meta.env.VITE_GATEWAY_WS || 'ws://localhost:3000/ws';

// ── Stat Card ──────────────────────────────────────────────────────────────
function StatCard({ label, value, unit, color = '#6366f1', delta }) {
  return (
    <div style={{
      background: '#111118', border: '1px solid #2a2a3a', borderRadius: 12,
      padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <span style={{ color: '#6b6b80', fontSize: 11, fontFamily: 'JetBrains Mono', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
      <span style={{ color, fontSize: 32, fontWeight: 700, fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
        {value ?? '—'}<span style={{ fontSize: 14, color: '#6b6b80', marginLeft: 4 }}>{unit}</span>
      </span>
      {delta !== undefined && (
        <span style={{ fontSize: 11, color: delta >= 0 ? '#10b981' : '#ef4444', fontFamily: 'JetBrains Mono' }}>
          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs prev min
        </span>
      )}
    </div>
  );
}

// ── Circuit Breaker Badge ──────────────────────────────────────────────────
function CBBadge({ state }) {
  const colors = { closed: '#10b981', open: '#ef4444', half_open: '#f59e0b' };
  return (
    <span style={{
      background: (colors[state] || '#6b6b80') + '22',
      color: colors[state] || '#6b6b80',
      border: `1px solid ${colors[state] || '#6b6b80'}44`,
      borderRadius: 6, padding: '2px 8px', fontSize: 11, fontFamily: 'JetBrains Mono', fontWeight: 600,
    }}>
      {state?.toUpperCase() || 'UNKNOWN'}
    </span>
  );
}

// ── Custom Tooltip ─────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#1a1a24', border: '1px solid #2a2a3a', borderRadius: 8, padding: '10px 14px', fontSize: 12, fontFamily: 'JetBrains Mono' }}>
      <div style={{ color: '#6b6b80', marginBottom: 6 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <b>{Math.round(p.value)}</b>{p.name.includes('ms') || p.name === 'p50' || p.name === 'p95' || p.name === 'p99' ? 'ms' : ''}
        </div>
      ))}
    </div>
  );
}

// ── Add Route Modal ────────────────────────────────────────────────────────
function AddRouteModal({ onAdd, onClose }) {
  const [form, setForm] = useState({
    id: '', pathPrefix: '/new-route', upstreamUrl: 'http://upstream1:4001', rps: 10, authRequired: false,
  });
  const [result, setResult] = useState(null);

  async function submit() {
    const route = {
      id: form.id || form.pathPrefix.replace(/\//g, '-').replace(/^-/, ''),
      pathPrefix: form.pathPrefix,
      upstreams: [{ url: form.upstreamUrl, weight: 1 }],
      plugins: {
        rateLimit: { enabled: true, requestsPerSecond: parseInt(form.rps), burst: parseInt(form.rps) * 2 },
        auth: { enabled: form.authRequired },
        retry: { enabled: true, maxRetries: 3, backoffMs: 100 },
        circuitBreaker: { enabled: true, threshold: 5, resetTimeoutMs: 30000 },
      },
    };
    const res = await onAdd(route);
    setResult(res);
  }

  const inp = (field) => ({
    value: form[field],
    onChange: (e) => setForm({ ...form, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }),
    style: {
      width: '100%', background: '#0a0a0f', border: '1px solid #2a2a3a', borderRadius: 8,
      color: '#e8e8f0', padding: '10px 12px', fontFamily: 'JetBrains Mono', fontSize: 13, outline: 'none',
    },
  });

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000000cc', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div style={{ background: '#111118', border: '1px solid #2a2a3a', borderRadius: 16, padding: 32, width: 480, maxWidth: '90vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>Add Route — Hot Reload</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6b6b80', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>
        {result ? (
          <div>
            <div style={{ background: '#10b98122', border: '1px solid #10b98144', borderRadius: 8, padding: 16, fontFamily: 'JetBrains Mono', fontSize: 12, whiteSpace: 'pre-wrap', color: '#10b981' }}>
              {JSON.stringify(result, null, 2)}
            </div>
            <button onClick={onClose} style={{ marginTop: 16, width: '100%', padding: '12px', background: '#6366f1', border: 'none', borderRadius: 8, color: '#fff', fontFamily: 'JetBrains Mono', fontWeight: 600, cursor: 'pointer' }}>Close</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[['Route ID (auto if blank)', 'id'], ['Path Prefix', 'pathPrefix'], ['Upstream URL', 'upstreamUrl'], ['Requests/sec limit', 'rps']].map(([label, field]) => (
              <div key={field}>
                <label style={{ fontSize: 11, color: '#6b6b80', fontFamily: 'JetBrains Mono', display: 'block', marginBottom: 6 }}>{label}</label>
                <input {...inp(field)} />
              </div>
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" {...inp('authRequired')} style={{ width: 'auto' }} />
              <span style={{ fontFamily: 'JetBrains Mono', color: '#e8e8f0' }}>Require JWT auth</span>
            </label>
            <button onClick={submit} style={{ padding: '12px', background: '#6366f1', border: 'none', borderRadius: 8, color: '#fff', fontFamily: 'JetBrains Mono', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
              ⚡ Create Route (no restart needed)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Live Request Feed ──────────────────────────────────────────────────────
function RequestFeed({ requests }) {
  const statusColor = (s) => s >= 500 ? '#ef4444' : s >= 400 ? '#f59e0b' : '#10b981';
  return (
    <div style={{ background: '#111118', border: '1px solid #2a2a3a', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #2a2a3a', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block', boxShadow: '0 0 6px #10b981' }} />
        <span style={{ fontWeight: 600, fontSize: 14 }}>Live Request Feed</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6b6b80', fontFamily: 'JetBrains Mono' }}>{requests.length} recent</span>
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        {requests.length === 0 ? (
          <div style={{ padding: 24, color: '#6b6b80', textAlign: 'center', fontSize: 13, fontFamily: 'JetBrains Mono' }}>
            Waiting for requests...
          </div>
        ) : requests.map((r, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '60px 60px 1fr 80px 60px',
            gap: 12, padding: '8px 20px', borderBottom: '1px solid #1a1a24',
            fontSize: 12, fontFamily: 'JetBrains Mono', alignItems: 'center',
            opacity: i > 0 ? 0.8 - i * 0.01 : 1,
          }}>
            <span style={{ color: '#6366f1', fontWeight: 600 }}>{r.method}</span>
            <span style={{ color: statusColor(r.status), fontWeight: 600 }}>{r.status}</span>
            <span style={{ color: '#e8e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.path}</span>
            <span style={{ color: '#6b6b80' }}>{r.latency}ms</span>
            <span style={{ color: '#6b6b80', fontSize: 10 }}>{r.routeId}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const { status, lastStats, recentRequests } = useWebSocket(GATEWAY_WS);
  const { analytics, routes, circuitBreakers, loading, addRoute, deleteRoute, resetCircuitBreaker, getToken } = useAnalytics(15000);
  const [showAddRoute, setShowAddRoute] = useState(false);
  const [tab, setTab] = useState('overview');
  const [tokenInfo, setTokenInfo] = useState(null);
  const [rpsHistory, setRpsHistory] = useState([]);

  // Track RPS history
  useEffect(() => {
    if (lastStats) {
      setRpsHistory((prev) => {
        const entry = { time: new Date().toLocaleTimeString(), rps: parseInt(lastStats.rps || 0), p50: lastStats.p50, p95: lastStats.p95 };
        return [...prev.slice(-60), entry];
      });
    }
  }, [lastStats]);

  const timeseries = analytics?.latencyTimeseries?.slice(0, 30).reverse().map((r) => ({
    time: (() => { const d = r.bucket instanceof Date ? r.bucket : new Date(r.bucket); return isNaN(d) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); })(),
    p50: Math.round(r.p50 || 0),
    p95: Math.round(r.p95 || 0),
    p99: Math.round(r.p99 || 0),
    errors: parseInt(r.errors || 0),
    total: parseInt(r.total || 0),
  })) || [];

  const errorRate = analytics?.summary
    ? ((analytics.summary.error_requests / analytics.summary.total_requests) * 100).toFixed(1)
    : 0;

  const statusColors = { connected: '#10b981', disconnected: '#ef4444', connecting: '#f59e0b', error: '#ef4444' };

  const tabStyle = (t) => ({
    padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'JetBrains Mono',
    fontSize: 13, fontWeight: 600, transition: 'all 0.15s',
    background: tab === t ? '#6366f1' : 'transparent',
    color: tab === t ? '#fff' : '#6b6b80',
  });

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0f', color: '#e8e8f0' }}>
      {/* Header */}
      <div style={{ borderBottom: '1px solid #2a2a3a', padding: '0 32px', display: 'flex', alignItems: 'center', height: 60, gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: -0.5 }}>PulseAPI</span>
          <span style={{ color: '#6b6b80', fontSize: 13, fontFamily: 'JetBrains Mono' }}>/ Gateway Dashboard</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontFamily: 'JetBrains Mono' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColors[status], display: 'inline-block', boxShadow: `0 0 6px ${statusColors[status]}` }} />
            <span style={{ color: '#6b6b80' }}>WS: </span>
            <span style={{ color: statusColors[status] }}>{status}</span>
          </div>
          {lastStats && (
            <span style={{ fontFamily: 'JetBrains Mono', fontSize: 13, color: '#6366f1', fontWeight: 600 }}>
              {lastStats.rps} req/s
            </span>
          )}
          <button onClick={() => setShowAddRoute(true)} style={{
            background: '#6366f1', border: 'none', borderRadius: 8, color: '#fff',
            padding: '8px 16px', fontFamily: 'JetBrains Mono', fontWeight: 600, cursor: 'pointer', fontSize: 13,
          }}>+ Route</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ padding: '16px 32px', borderBottom: '1px solid #2a2a3a', display: 'flex', gap: 4 }}>
        {['overview', 'latency', 'routes', 'logs'].map((t) => (
          <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      <div style={{ padding: 32 }}>
        {/* OVERVIEW TAB */}
        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {/* Stat Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
              <StatCard label="Requests/sec" value={lastStats?.rps ?? analytics?.summary?.total_requests} unit="rps" color="#6366f1" />
              <StatCard label="p50 Latency" value={Math.round(lastStats?.p50 ?? analytics?.summary?.p50 ?? 0)} unit="ms" color="#22d3ee" />
              <StatCard label="p95 Latency" value={Math.round(lastStats?.p95 ?? analytics?.summary?.p95 ?? 0)} unit="ms" color="#f59e0b" />
              <StatCard label="p99 Latency" value={Math.round(analytics?.summary?.p99 ?? 0)} unit="ms" color="#ef4444" />
              <StatCard label="Error Rate" value={errorRate} unit="%" color={parseFloat(errorRate) > 5 ? '#ef4444' : '#10b981'} />
              <StatCard label="Total (1hr)" value={analytics?.summary?.total_requests} unit="reqs" color="#10b981" />
            </div>

            {/* RPS Chart */}
            <div style={{ background: '#111118', border: '1px solid #2a2a3a', borderRadius: 12, padding: 24 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 20, fontFamily: 'JetBrains Mono' }}>Live Requests/sec</h3>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={rpsHistory}>
                  <defs>
                    <linearGradient id="rpsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="rps" stroke="#6366f1" fill="url(#rpsGrad)" strokeWidth={2} name="rps" />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Error breakdown + top endpoints */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ background: '#111118', border: '1px solid #2a2a3a', borderRadius: 12, padding: 24 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 20, fontFamily: 'JetBrains Mono' }}>Status Code Distribution</h3>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={analytics?.errorBreakdown || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="status_code" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{ background: '#111118', border: '1px solid #2a2a3a', borderRadius: 12, padding: 24 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, fontFamily: 'JetBrains Mono' }}>Top Endpoints</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {(analytics?.topEndpoints || []).slice(0, 6).map((e) => (
                    <div key={e.path} style={{ display: 'flex', gap: 12, alignItems: 'center', fontFamily: 'JetBrains Mono', fontSize: 12 }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#e8e8f0' }}>{e.path}</span>
                      <span style={{ color: '#6b6b80' }}>{e.count} reqs</span>
                      <span style={{ color: '#22d3ee' }}>{e.avg_latency}ms</span>
                    </div>
                  ))}
                  {!analytics?.topEndpoints?.length && (
                    <span style={{ color: '#6b6b80', fontSize: 13 }}>No data yet — send some requests!</span>
                  )}
                </div>
              </div>
            </div>

            <RequestFeed requests={recentRequests} />
          </div>
        )}

        {/* LATENCY TAB */}
        {tab === 'latency' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div style={{ background: '#111118', border: '1px solid #2a2a3a', borderRadius: 12, padding: 24 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 20, fontFamily: 'JetBrains Mono' }}>Latency Percentiles — Last 1 Hour</h3>
              <ResponsiveContainer width="100%" height={350}>
                <LineChart data={timeseries}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} />
                  <YAxis unit="ms" tick={{ fontSize: 10 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <Line type="monotone" dataKey="p50" stroke="#22d3ee" strokeWidth={2} dot={false} name="p50" />
                  <Line type="monotone" dataKey="p95" stroke="#f59e0b" strokeWidth={2} dot={false} name="p95" />
                  <Line type="monotone" dataKey="p99" stroke="#ef4444" strokeWidth={2} dot={false} name="p99" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: '#111118', border: '1px solid #2a2a3a', borderRadius: 12, padding: 24 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 20, fontFamily: 'JetBrains Mono' }}>Error Rate Over Time</h3>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={timeseries}>
                  <defs>
                    <linearGradient id="errGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="errors" stroke="#ef4444" fill="url(#errGrad)" strokeWidth={2} name="errors" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* ROUTES TAB */}
        {tab === 'routes' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Routes ({routes.length})</h2>
              <button onClick={() => setShowAddRoute(true)} style={{
                background: '#6366f1', border: 'none', borderRadius: 8, color: '#fff',
                padding: '10px 20px', fontFamily: 'JetBrains Mono', fontWeight: 600, cursor: 'pointer',
              }}>+ Add Route (Hot Reload)</button>
            </div>

            {routes.map((route) => (
              <div key={route.id} style={{ background: '#111118', border: '1px solid #2a2a3a', borderRadius: 12, padding: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                  <div>
                    <span style={{ fontFamily: 'JetBrains Mono', fontSize: 16, fontWeight: 700, color: '#6366f1' }}>{route.id}</span>
                    <span style={{ marginLeft: 16, fontFamily: 'JetBrains Mono', fontSize: 13, color: '#6b6b80' }}>{route.pathPrefix}/*</span>
                  </div>
                  <button onClick={() => deleteRoute(route.id)} style={{
                    background: '#ef444422', border: '1px solid #ef444444', borderRadius: 6, color: '#ef4444',
                    padding: '4px 12px', fontFamily: 'JetBrains Mono', fontSize: 12, cursor: 'pointer',
                  }}>Delete</button>
                </div>

                {/* Upstreams + Circuit Breakers */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: '#6b6b80', fontFamily: 'JetBrains Mono', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Upstreams</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {route.upstreams.map((u) => {
                      const cbState = circuitBreakers[u.url];
                      return (
                        <div key={u.url} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#0a0a0f', border: '1px solid #2a2a3a', borderRadius: 8, padding: '6px 12px' }}>
                          <span style={{ fontFamily: 'JetBrains Mono', fontSize: 12, color: '#e8e8f0' }}>{u.url}</span>
                          <CBBadge state={cbState || 'closed'} />
                          {cbState === 'open' && (
                            <button onClick={() => resetCircuitBreaker(u.url)} style={{
                              background: '#f59e0b22', border: '1px solid #f59e0b44', borderRadius: 4, color: '#f59e0b',
                              padding: '2px 8px', fontFamily: 'JetBrains Mono', fontSize: 10, cursor: 'pointer',
                            }}>Reset</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Plugins */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {Object.entries(route.plugins).map(([name, cfg]) => (
                    <span key={name} style={{
                      background: cfg.enabled ? '#6366f122' : '#2a2a3a',
                      border: `1px solid ${cfg.enabled ? '#6366f144' : '#3a3a4a'}`,
                      color: cfg.enabled ? '#6366f1' : '#6b6b80',
                      borderRadius: 6, padding: '3px 10px', fontSize: 11, fontFamily: 'JetBrains Mono',
                    }}>
                      {name}{cfg.enabled && cfg.requestsPerSecond ? ` (${cfg.requestsPerSecond}/s)` : ''}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* LOGS TAB */}
        {tab === 'logs' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Live Request Logs</h2>
              <button onClick={async () => {
                const t = await getToken();
                setTokenInfo(t);
              }} style={{
                background: '#22d3ee22', border: '1px solid #22d3ee44', borderRadius: 8, color: '#22d3ee',
                padding: '8px 16px', fontFamily: 'JetBrains Mono', fontSize: 12, cursor: 'pointer',
              }}>Generate Test JWT</button>
            </div>

            {tokenInfo && (
              <div style={{ background: '#111118', border: '1px solid #22d3ee44', borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 11, color: '#22d3ee', fontFamily: 'JetBrains Mono', marginBottom: 8 }}>TEST JWT TOKEN</div>
                <div style={{ fontFamily: 'JetBrains Mono', fontSize: 11, wordBreak: 'break-all', color: '#e8e8f0' }}>{tokenInfo.token}</div>
                <div style={{ marginTop: 8, fontSize: 11, color: '#6b6b80', fontFamily: 'JetBrains Mono' }}>{tokenInfo.usage}</div>
              </div>
            )}

            <div style={{ background: '#111118', border: '1px solid #2a2a3a', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '12px 20px', borderBottom: '1px solid #2a2a3a', display: 'grid', gridTemplateColumns: '60px 60px 1fr 100px 70px 70px', gap: 12, fontSize: 10, fontFamily: 'JetBrains Mono', color: '#6b6b80', textTransform: 'uppercase' }}>
                <span>Method</span><span>Status</span><span>Path</span><span>Route</span><span>Latency</span><span>Retries</span>
              </div>
              {recentRequests.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#6b6b80', fontFamily: 'JetBrains Mono', fontSize: 13 }}>
                  No requests yet. Try: curl http://localhost:3000/api/test
                </div>
              ) : recentRequests.map((r, i) => {
                const sc = r.status || 200;
                const color = sc >= 500 ? '#ef4444' : sc >= 400 ? '#f59e0b' : '#10b981';
                return (
                  <div key={i} style={{
                    display: 'grid', gridTemplateColumns: '60px 60px 1fr 100px 70px 70px',
                    gap: 12, padding: '10px 20px', borderBottom: '1px solid #1a1a24',
                    fontSize: 12, fontFamily: 'JetBrains Mono', alignItems: 'center',
                  }}>
                    <span style={{ color: '#6366f1', fontWeight: 600 }}>{r.method}</span>
                    <span style={{ color, fontWeight: 600 }}>{sc}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.path}</span>
                    <span style={{ color: '#6b6b80', fontSize: 11 }}>{r.routeId || '—'}</span>
                    <span style={{ color: r.latency > 500 ? '#ef4444' : r.latency > 200 ? '#f59e0b' : '#10b981' }}>{r.latency}ms</span>
                    <span style={{ color: r.retries > 0 ? '#f59e0b' : '#6b6b80' }}>{r.retries || 0}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {showAddRoute && <AddRouteModal onAdd={addRoute} onClose={() => setShowAddRoute(false)} />}
    </div>
  );
}
  