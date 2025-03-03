const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey123';
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret-key';

function authPlugin() {
  return async (req, res, next, config) => {
    if (!config.enabled) return next();

    // Check API key first
    const apiKey = req.headers['x-api-key'];
    if (apiKey === ADMIN_KEY) {
      req.apiKey = 'admin';
      req.authType = 'admin-key';
      return next();
    }

    // Try JWT Bearer token
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        req.apiKey = decoded.sub || decoded.id;
        req.authType = 'jwt';

        // Strip auth headers before forwarding upstream
        delete req.headers['authorization'];

        return next();
      } catch (err) {
        return res.status(401).json({
          error: 'Invalid or expired JWT token',
          hint: 'POST /admin/token to get a test token',
        });
      }
    }

    return res.status(401).json({
      error: 'Authentication required',
      hint: 'Provide Authorization: Bearer <token> or X-Api-Key header',
    });
  };
}

// Generate a test JWT
function generateTestToken(payload = {}) {
  return jwt.sign(
    { sub: 'test-user', role: 'user', ...payload },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

module.exports = { authPlugin, generateTestToken };
