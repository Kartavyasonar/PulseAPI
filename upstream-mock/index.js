const express = require('express');
const app = express();
app.use(express.json());

const PORT        = parseInt(process.env.PORT || '4001');
const SERVICE     = process.env.SERVICE_NAME || 'upstream-mock';
const FAIL_RATE   = parseFloat(process.env.FAIL_RATE || '0.05');
const MIN_LATENCY = parseInt(process.env.MIN_LATENCY || '10');
const MAX_LATENCY = parseInt(process.env.MAX_LATENCY || '200');

function latency() {
  // 1% spike to simulate occasional slow responses
  const base = MIN_LATENCY + Math.random() * (MAX_LATENCY - MIN_LATENCY);
  return Math.random() < 0.01 ? base * 5 : base;
}

app.use(async (req, res, next) => {
  await new Promise(r => setTimeout(r, latency()));
  next();
});

app.all('*', (req, res) => {
  if (Math.random() < FAIL_RATE) {
    return res.status(500).json({ error: 'simulated upstream failure', service: SERVICE });
  }
  res.json({
    service: SERVICE,
    method: req.method,
    path: req.path,
    query: req.query,
    body: req.body,
    forwarded: {
      for: req.headers['x-forwarded-for'],
      gateway: req.headers['x-gateway'],
    },
    timestamp: new Date().toISOString(),
    requestId: Math.random().toString(36).slice(2),
  });
});

app.listen(PORT, () => console.log(`[${SERVICE}] :${PORT}  fail_rate=${FAIL_RATE}`));
