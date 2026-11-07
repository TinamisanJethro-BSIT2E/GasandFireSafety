const jwt = require('jsonwebtoken');
const db = require('./db');

const cookieName = 'gas_safety_token';

function readToken(req) {
  if (req.cookies && req.cookies[cookieName]) return req.cookies[cookieName];
  const authorization = req.get('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
}

function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare('SELECT id, username, role, must_change_password FROM users WHERE id = ?').get(claims.id);
    if (!user) return res.status(401).json({ error: 'Account is no longer active' });
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: Boolean(user.must_change_password)
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Session expired; please log in again' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    return next();
  };
}

function issueToken(user) {
  return jwt.sign({
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: Boolean(user.must_change_password)
  }, process.env.JWT_SECRET, { expiresIn: '12h' });
}

module.exports = { cookieName, issueToken, requireAuth, requireRole };
