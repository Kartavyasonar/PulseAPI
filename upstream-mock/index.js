const express = require('express');
const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '4001');
const SERVICE = process.env.SERVICE_NAME || 'mock';
const FAIL_RATE = parseFloat(process.env.FAIL_RATE || '0.05');

app.all('*', (req, res) => {
  if (Math.random() < FAIL_RATE) {
    return res.status(500).json({ error: 'simulated failure', service: SERVICE });
  }
  res.json({
    service: SERVICE,
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => console.log(`[${SERVICE}] :${PORT}`));
