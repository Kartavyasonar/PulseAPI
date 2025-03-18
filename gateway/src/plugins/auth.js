const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';
const ADMIN_KEY  = process.env.ADMIN_KEY  || 'admin-secret-key';

function authPlugin() {
  return async (req, res, next, config) => {
    if (!config || !config.enabled) return next();

    // API key shortcut (admin only)
    if (req.headers['x-api-key'] === ADMIN_KEY) {
      req.apiKey = 'admin';
      return next();
    }

    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing auth', hint: 'Authorization: Bearer <jwt>' });
    }

    try {
      const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
      req.user   = decoded;
      req.apiKey = decoded.sub || decoded.id;
      // strip before forwarding — upstream shouldn't see our internal tokens
      delete req.headers['authorization'];
      next();
    } catch (e) {
      res.status(401).json({ error: 'invalid token', detail: e.message });
    }
  };
}

function generateTestToken(payload = {}) {
  return jwt.sign({ sub: 'test-user', role: 'user', ...payload }, JWT_SECRET, { expiresIn: '24h' });
}

module.exports = { authPlugin, generateTestToken };
