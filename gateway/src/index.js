const express = require('express');
const http = require('http');
const config = require('../config.json');
const app = express();

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// very basic proxy — forward to upstream
app.all('*', (req, res) => {
  const route = config.routes.find(r => req.path.startsWith(r.pathPrefix));
  if (!route) return res.status(404).json({ error: 'no route' });

  const upstreamUrl = new URL(route.upstream);
  const options = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port,
    path: req.originalUrl,
    method: req.method,
    headers: req.headers,
  };

  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    res.status(502).json({ error: 'upstream unreachable', detail: err.message });
  });

  req.pipe(proxyReq);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`gateway on :${PORT}`));
