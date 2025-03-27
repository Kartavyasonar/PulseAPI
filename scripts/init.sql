CREATE TABLE IF NOT EXISTS requests (
  id          BIGSERIAL PRIMARY KEY,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method      VARCHAR(10) NOT NULL,
  path        TEXT NOT NULL,
  route_id    VARCHAR(100),
  upstream    VARCHAR(200),
  client_ip   INET,
  api_key     VARCHAR(100),
  status_code INTEGER,
  latency_ms  INTEGER,
  retries     INTEGER DEFAULT 0,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_requests_client_ip ON requests (client_ip, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_requests_route     ON requests (route_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_requests_status    ON requests (status_code, timestamp DESC);

CREATE TABLE IF NOT EXISTS routes (
  id          VARCHAR(100) PRIMARY KEY,
  path_prefix TEXT NOT NULL,
  upstreams   JSONB NOT NULL,
  plugins     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_hash   VARCHAR(64) PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  rate_limit INTEGER DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  active     BOOLEAN DEFAULT TRUE
);

INSERT INTO routes (id, path_prefix, upstreams, plugins) VALUES
(
  'api-service', '/api',
  '[{"url":"http://upstream1:4001","weight":1},{"url":"http://upstream2:4002","weight":1},{"url":"http://upstream3:4003","weight":1}]',
  '{"rateLimit":{"enabled":true,"requestsPerSecond":50,"burst":10},"auth":{"enabled":false},"retry":{"enabled":true,"maxRetries":3,"backoffMs":100},"circuitBreaker":{"enabled":true,"threshold":5,"resetTimeoutMs":30000}}'
),
(
  'public-service', '/public',
  '[{"url":"http://upstream3:4003","weight":1}]',
  '{"rateLimit":{"enabled":true,"requestsPerSecond":10,"burst":5},"auth":{"enabled":false},"retry":{"enabled":true,"maxRetries":2,"backoffMs":200},"circuitBreaker":{"enabled":true,"threshold":5,"resetTimeoutMs":30000}}'
),
(
  'secure-service', '/secure',
  '[{"url":"http://upstream1:4001","weight":1}]',
  '{"rateLimit":{"enabled":true,"requestsPerSecond":20,"burst":5},"auth":{"enabled":true},"retry":{"enabled":true,"maxRetries":3,"backoffMs":100},"circuitBreaker":{"enabled":true,"threshold":5,"resetTimeoutMs":30000}}'
)
ON CONFLICT (id) DO NOTHING;
