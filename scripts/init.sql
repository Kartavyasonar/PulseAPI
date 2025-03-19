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

-- index on timestamp for time-range queries (most common analytics query)
CREATE INDEX idx_requests_timestamp ON requests (timestamp DESC);
-- index for per-client analytics
CREATE INDEX idx_requests_client_ip ON requests (client_ip, timestamp DESC);
-- index for per-route analytics
CREATE INDEX idx_requests_route ON requests (route_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS routes (
  id          VARCHAR(100) PRIMARY KEY,
  path_prefix TEXT NOT NULL,
  upstreams   JSONB NOT NULL,
  plugins     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
