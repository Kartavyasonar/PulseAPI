const express = require('express');
const app = express();

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// TODO: add route matching
app.all('*', (req, res) => {
  res.status(404).json({ error: 'no routes configured' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`gateway listening on :${PORT}`));
