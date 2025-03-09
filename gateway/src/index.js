require('dotenv').config();
const express = require('express');
const http = require('http');
const { RouteManager } = require('./utils/routeManager');

const app = express();
app.use(express.json());

const routeManager = new RouteManager();

// load from config for now, will move to DB
const config = require('../config.json');
routeManager.load(config.routes || []);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', routes: routeManager.list().length });
});

app.get('/admin/routes', (req, res) => {
  res.json({ routes: routeManager.list() });
});

app.all('*', (req, res) => {
  const route = routeManager.match(req.path);
  if (!route) return res.status(404).json({ error: 'no route matched', path: req.path });

  const upstream = Array.isArray(route.upstreams) ? route.upstreams[0] : { url: route.upstream };
  const targetUrl = new URL(upstream.url);

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || 80,
    path: req.originalUrl.replace(new RegExp(`^${route.pathPrefix}`), '') || '/',
    method: req.method,
    headers: { ...req.headers, host: targetUrl.host },
    timeout: 8000,
  };

  const proxyReq = http.request(options, proxyRes => {
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode).send(Buffer.concat(chunks));
    });
  });

  proxyReq.on('error', err => res.status(502).json({ error: err.message }));
  proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(504).json({ error: 'gateway timeout' }); });

  if (['POST','PUT','PATCH'].includes(req.method)) req.pipe(proxyReq);
  else proxyReq.end();
});

app.listen(3000, () => console.log('gateway :3000'));
