-- ─── Core tables ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS requests (
  id          BIGSERIAL PRIMARY KEY,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method      VARCHAR(10) NOT NULL,
  path        TEXT NOT NULL,
  route_id    VARCHAR(100),
  upstream    VARCHAR(200),
  client_ip   INET,
  api_key     VARCHAR(100),
  tenant_id   VARCHAR(100),
  status_code INTEGER,
  latency_ms  INTEGER,
  retries     INTEGER DEFAULT 0,
  trace_id    VARCHAR(64),
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_requests_client_ip ON requests (client_ip, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_requests_route     ON requests (route_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_requests_status    ON requests (status_code, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_requests_tenant    ON requests (tenant_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS routes (
  id          VARCHAR(100) PRIMARY KEY,
  path_prefix TEXT NOT NULL,
  upstreams   JSONB NOT NULL,
  plugins     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Multi-tenancy ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id         VARCHAR(100) PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  tier       VARCHAR(20) NOT NULL CHECK (tier IN ('free','pro','enterprise')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_api_keys (
  key_hash   VARCHAR(64) PRIMARY KEY,
  tenant_id  VARCHAR(100) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_active  BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS tenant_quota_config (
  tenant_id          VARCHAR(100) PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  requests_per_second INT NOT NULL DEFAULT 10,
  requests_per_minute INT NOT NULL DEFAULT 500,
  requests_per_day    INT NOT NULL DEFAULT 50000,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Seed tenants ─────────────────────────────────────────────────────────

INSERT INTO tenants (id, name, tier) VALUES
  ('free-tenant',       'Free Tier Corp',       'free'),
  ('pro-tenant',        'Pro Tier Inc',          'pro'),
  ('enterprise-tenant', 'Enterprise Systems Ltd','enterprise')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenant_quota_config (tenant_id, requests_per_second, requests_per_minute, requests_per_day) VALUES
  ('free-tenant',        10,   500,    50000),
  ('pro-tenant',        100,  5000,   500000),
  ('enterprise-tenant',1000, 50000, 10000000)
ON CONFLICT (tenant_id) DO NOTHING;

-- API keys stored as SHA-256 hashes — raw keys never persisted
-- free-key-plaintext      -> sha256 shown below (for testing)
-- pro-key-plaintext       -> sha256
-- enterprise-key-plaintext-> sha256
INSERT INTO tenant_api_keys (key_hash, tenant_id, name) VALUES
  (encode(sha256('free-key-plaintext'::bytea),      'hex'), 'free-tenant',       'default key'),
  (encode(sha256('pro-key-plaintext'::bytea),       'hex'), 'pro-tenant',        'default key'),
  (encode(sha256('enterprise-key-plaintext'::bytea),'hex'), 'enterprise-tenant', 'default key')
ON CONFLICT (key_hash) DO NOTHING;

-- ─── Default routes ───────────────────────────────────────────────────────

INSERT INTO routes (id, path_prefix, upstreams, plugins) VALUES
(
  'api-service', '/api',
  '[{"url":"http://upstream1:4001","weight":1},{"url":"http://upstream2:4002","weight":1},{"url":"http://upstream3:4003","weight":1}]',
  '{"rateLimit":{"enabled":true,"requestsPerSecond":50,"burst":10,"algorithm":"token-bucket"},"auth":{"enabled":false},"retry":{"enabled":true,"maxRetries":3,"backoffMs":100},"circuitBreaker":{"enabled":true,"threshold":5,"resetTimeoutMs":30000}}'
),
(
  'public-service', '/public',
  '[{"url":"http://upstream3:4003","weight":1}]',
  '{"rateLimit":{"enabled":true,"requestsPerSecond":10,"burst":5,"algorithm":"sliding-window"},"auth":{"enabled":false},"retry":{"enabled":true,"maxRetries":2,"backoffMs":200},"circuitBreaker":{"enabled":true,"threshold":5,"resetTimeoutMs":30000}}'
),
(
  'secure-service', '/secure',
  '[{"url":"http://upstream1:4001","weight":1}]',
  '{"rateLimit":{"enabled":true,"requestsPerSecond":20,"burst":5,"algorithm":"token-bucket"},"auth":{"enabled":true},"retry":{"enabled":true,"maxRetries":3,"backoffMs":100},"circuitBreaker":{"enabled":true,"threshold":5,"resetTimeoutMs":30000}}'
)
ON CONFLICT (id) DO NOTHING;
