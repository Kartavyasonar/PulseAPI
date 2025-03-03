const express = require('express');
const app = express();

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// placeholder — will add routing engine
app.all('*', (req, res) => {
  res.status(404).json({ error: 'no routes configured yet' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`gateway on :${PORT}`));
