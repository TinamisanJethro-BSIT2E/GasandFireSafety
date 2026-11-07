const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { cookieName, issueToken, requireAuth, requireRole } = require('./auth');

const router = express.Router();
const eventTypes = ['Gas Leak', 'Fire Detected', 'Cleared', 'SMS Sent', 'System'];
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});

function isIntegerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function getHistoryFilters(query) {
  const conditions = [];
  const params = {};
  if (query.from) {
    if (!validateDate(query.from)) throw new Error('Invalid from date');
    conditions.push("date(created_at) >= date(@from)");
    params.from = query.from;
  }
  if (query.to) {
    if (!validateDate(query.to)) throw new Error('Invalid to date');
    conditions.push("date(created_at) <= date(@to)");
    params.to = query.to;
  }
  if (query.type) {
    if (!eventTypes.includes(query.type)) throw new Error('Invalid event type');
    conditions.push('event_type = @type');
    params.type = query.type;
  }
  if (query.from && query.to && query.from > query.to) {
    throw new Error('From date must be on or before the to date');
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  };
}

function requireDeviceKey(req, res, next) {
  const supplied = req.get('x-device-api-key') || '';
  const expected = process.env.DEVICE_API_KEY || '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (!expected || suppliedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return res.status(401).json({ error: 'Invalid device API key' });
  }
  return next();
}

function publish(app, message) {
  const server = app.get('wsServer');
  if (!server) return;
  const payload = JSON.stringify(message);
  for (const client of server.clients) {
    if (client.readyState === 1 && client.authenticated) client.send(payload);
  }
}

function recordEvent(app, event) {
  const result = db.prepare(`
    INSERT INTO events (event_type, gas_value, actions, details)
    VALUES (@event_type, @gas_value, @actions, @details)
  `).run({
    event_type: event.event_type,
    gas_value: event.gas_value ?? null,
    actions: JSON.stringify(Array.isArray(event.actions) ? event.actions : []),
    details: event.details || ''
  });
  const saved = db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid);
  publish(app, { type: 'event', event: saved });
  return saved;
}

async function sendTelegram(event) {
  const settings = db.prepare('SELECT telegram_enabled FROM settings WHERE id = 1').get();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!settings.telegram_enabled || !token || !chatId) return;
  const message = `${event.event_type} alert\nGas reading: ${event.gas_value ?? 'n/a'}\n${(event.actions || []).join(', ')}`;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message })
  });
  if (!response.ok) throw new Error(`Telegram API returned HTTP ${response.status}`);
}

router.post('/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' ||
      username.length > 64 || password.length > 256) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const secure = process.env.NODE_ENV === 'production';
  res.cookie(cookieName, issueToken(user), {
    httpOnly: true, sameSite: 'strict', secure, maxAge: 12 * 60 * 60 * 1000, path: '/'
  });
  return res.json({
    user: { id: user.id, username: user.username, role: user.role },
    mustChangePassword: Boolean(user.must_change_password)
  });
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie(cookieName, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ ok: true });
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id, username: req.user.username, role: req.user.role,
    mustChangePassword: Boolean(req.user.mustChangePassword)
  });
});

router.post('/auth/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' ||
      newPassword.length < 10 || newPassword.length > 128) {
    return res.status(400).json({ error: 'New password must be 10-128 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 12), user.id);
  const updated = { ...user, must_change_password: 0 };
  res.cookie(cookieName, issueToken(updated), {
    httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000, path: '/'
  });
  return res.json({ ok: true });
});

router.get('/status', requireAuth, (req, res) => {
  const latest = db.prepare('SELECT * FROM readings ORDER BY id DESC LIMIT 1').get();
  const points = db.prepare(`
    SELECT id, gas_value, flame_detected, status, created_at
    FROM (SELECT * FROM readings ORDER BY id DESC LIMIT 60)
    ORDER BY id ASC
  `).all();
  const settings = db.prepare('SELECT gas_threshold, detection_delay FROM settings WHERE id = 1').get();
  const lastSeen = latest ? `${latest.created_at.replace(' ', 'T')}Z` : null;
  const online = Boolean(latest && Date.now() - Date.parse(lastSeen) < 15000);
  res.json({
    online, lastSeen,
    reading: latest || null,
    threshold: settings.gas_threshold,
    points
  });
});

router.get('/history', requireAuth, (req, res) => {
  let filters;
  try {
    filters = getHistoryFilters(req.query);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const page = Number.parseInt(req.query.page || '1', 10);
  if (!Number.isInteger(page) || page < 1 || page > 100000) return res.status(400).json({ error: 'Invalid page' });
  const limit = 20;
  const total = db.prepare(`SELECT COUNT(*) AS count FROM events ${filters.where}`).get(filters.params).count;
  const items = db.prepare(`
    SELECT * FROM events ${filters.where} ORDER BY id DESC LIMIT @limit OFFSET @offset
  `).all({ ...filters.params, limit, offset: (page - 1) * limit });
  res.json({ items, page, pages: Math.max(1, Math.ceil(total / limit)), total });
});

router.get('/history/export', requireAuth, (req, res) => {
  let filters;
  try {
    filters = getHistoryFilters(req.query);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const items = db.prepare(`SELECT * FROM events ${filters.where} ORDER BY id DESC LIMIT 10000`).all(filters.params);
  if (req.query.format === 'csv') {
    const escapeCsv = (value) => {
      let text = String(value ?? '');
      if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const rows = [
      ['Date', 'Event type', 'Gas value', 'Actions', 'Details'],
      ...items.map((item) => [
        item.created_at, item.event_type, item.gas_value, item.actions, item.details
      ])
    ];
    res.type('text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="gas-safety-history.csv"');
    res.set('X-Export-Rows', String(items.length));
    return res.send(`\uFEFF${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}`);
  }
  if (req.query.format === 'pdf') {
    res.type('application/pdf');
    res.set('Content-Disposition', 'attachment; filename="gas-safety-history.pdf"');
    res.set('X-Export-Rows', String(items.length));
    const pdf = new PDFDocument({ margin: 40, size: 'A4' });
    pdf.pipe(res);
    pdf.fontSize(18).text('Gas & Fire Safety Event History');
    pdf.fontSize(9).fillColor('#52645b').text(
      `Filters: ${filters.params.from || 'any date'} to ${filters.params.to || 'any date'} · ${filters.params.type || 'all event types'} · ${items.length} events`
    );
    pdf.fillColor('#17312b');
    pdf.moveDown();
    items.forEach((item) => {
      pdf.fontSize(10).text(`${item.created_at}  |  ${item.event_type}  |  Gas: ${item.gas_value ?? 'n/a'}`, {
        width: pdf.page.width - pdf.page.margins.left - pdf.page.margins.right
      });
      pdf.fontSize(9).fillColor('#52645b').text(`Actions: ${item.actions}${item.details ? ` · ${item.details}` : ''}`, {
        width: pdf.page.width - pdf.page.margins.left - pdf.page.margins.right
      });
      pdf.fillColor('#17312b').moveDown(0.55);
    });
    pdf.end();
    return;
  }
  return res.status(400).json({ error: 'format must be csv or pdf' });
});

router.get('/settings', requireAuth, (req, res) => {
  const settings = db.prepare('SELECT gas_threshold, detection_delay, telegram_enabled FROM settings WHERE id = 1').get();
  res.json({ ...settings, telegram_enabled: Boolean(settings.telegram_enabled) });
});

router.put('/settings', requireAuth, requireRole('admin'), (req, res) => {
  const { gas_threshold: threshold, detection_delay: delay, telegram_enabled: telegram } = req.body || {};
  if (!isIntegerInRange(threshold, 100, 4095)) return res.status(400).json({ error: 'Gas threshold must be between 100 and 4095 ADC counts' });
  if (!isIntegerInRange(delay, 1, 60)) return res.status(400).json({ error: 'Detection delay must be between 1 and 60 seconds' });
  if (typeof telegram !== 'boolean') return res.status(400).json({ error: 'telegram_enabled must be true or false' });
  db.prepare('UPDATE settings SET gas_threshold = ?, detection_delay = ?, telegram_enabled = ? WHERE id = 1')
    .run(threshold, delay, Number(telegram));
  const updated = db.prepare('SELECT gas_threshold, detection_delay, telegram_enabled FROM settings WHERE id = 1').get();
  updated.telegram_enabled = Boolean(updated.telegram_enabled);
  publish(req.app, { type: 'settings', settings: updated });
  res.json(updated);
});

router.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
  res.json({ users });
});

router.post('/users', requireAuth, requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body || {};
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) ||
      typeof password !== 'string' || password.length < 10 || password.length > 128 ||
      role !== 'viewer') {
    return res.status(400).json({ error: 'Provide a valid username, a 10-128 character password, and role viewer' });
  }
  try {
    const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, bcrypt.hashSync(password, 12), role);
    return res.status(201).json({ id: result.lastInsertRowid, username, role });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username already exists' });
    throw error;
  }
});

router.delete('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid user ID' });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin' && db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last administrator' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  const wsServer = req.app.get('wsServer');
  if (wsServer) {
    for (const client of wsServer.clients) {
      if (client.userId === id) client.close(1008, 'Account deleted');
    }
  }
  res.json({ ok: true });
});

router.post('/control', requireAuth, requireRole('admin'), (req, res) => {
  if (req.body?.command !== 'buzzer_test') {
    return res.status(400).json({ error: 'Only the safe buzzer_test command is supported' });
  }
  const result = db.prepare('INSERT INTO device_commands (command) VALUES (?)').run('buzzer_test');
  res.status(202).json({ id: result.lastInsertRowid, command: 'buzzer_test', status: 'pending' });
});

router.get('/device/config', requireDeviceKey, (req, res) => {
  const settings = db.prepare('SELECT gas_threshold, detection_delay FROM settings WHERE id = 1').get();
  res.set('Cache-Control', 'no-store').json(settings);
});

router.get('/device/commands', requireDeviceKey, (req, res) => {
  const command = db.prepare("SELECT id, command FROM device_commands WHERE status = 'pending' ORDER BY id LIMIT 1").get();
  res.json({ command: command || null });
});

router.post('/device/commands/:id/complete', requireDeviceKey, (req, res) => {
  const { success } = req.body || {};
  if (typeof success !== 'boolean') return res.status(400).json({ error: 'success must be a boolean' });
  const result = db.prepare(`
    UPDATE device_commands SET status = ?, completed_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(success ? 'completed' : 'failed', Number.parseInt(req.params.id, 10));
  if (!result.changes) return res.status(404).json({ error: 'Pending command not found' });
  res.json({ ok: true });
});

router.post('/device/data', requireDeviceKey, (req, res) => {
  const body = req.body || {};
  if (!isIntegerInRange(body.gas_value, 0, 4095) || typeof body.flame_detected !== 'boolean' ||
      !['Normal', 'Gas Leak', 'Fire Detected'].includes(body.status)) {
    return res.status(400).json({ error: 'Invalid gas_value, flame_detected, or status' });
  }
  const states = ['fan_on', 'pump_on', 'buzzer_on', 'regulator_open'];
  if (!states.every((key) => typeof body[key] === 'boolean')) {
    return res.status(400).json({ error: 'All device state fields must be booleans' });
  }
  const result = db.prepare(`
    INSERT INTO readings (gas_value, flame_detected, status, fan_on, pump_on, buzzer_on, regulator_open)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(body.gas_value, Number(body.flame_detected), body.status,
    Number(body.fan_on), Number(body.pump_on), Number(body.buzzer_on), Number(body.regulator_open));
  const reading = db.prepare('SELECT * FROM readings WHERE id = ?').get(result.lastInsertRowid);
  publish(req.app, { type: 'reading', reading });
  res.status(201).json({ ok: true, id: reading.id });
});

router.post('/device/event', requireDeviceKey, async (req, res, next) => {
  const body = req.body || {};
  if (!eventTypes.slice(0, 3).includes(body.event_type) ||
      !isIntegerInRange(body.gas_value, 0, 4095) ||
      !Array.isArray(body.actions) || body.actions.length > 12 ||
      !body.actions.every((action) => typeof action === 'string' && action.length <= 80)) {
    return res.status(400).json({ error: 'Invalid event type, gas value, or actions' });
  }
  try {
    const event = recordEvent(req.app, body);
    if (['Gas Leak', 'Fire Detected'].includes(body.event_type)) {
      recordEvent(req.app, {
        event_type: 'SMS Sent',
        gas_value: body.gas_value,
        actions: ['SMS handled by ESP32 GSM module'],
        details: 'SMS dispatch requested by on-device alarm logic'
      });
      sendTelegram({ ...body, actions: body.actions }).then(() => {
        recordEvent(req.app, {
          event_type: 'System', gas_value: body.gas_value,
          actions: ['Telegram notification sent'], details: 'Optional Telegram alert delivered'
        });
      }).catch((error) => {
        console.error('Telegram notification failed:', error.message);
        recordEvent(req.app, {
          event_type: 'System', gas_value: body.gas_value,
          actions: ['Telegram notification failed'], details: error.message
        });
      });
    }
    return res.status(201).json({ ok: true, id: event.id });
  } catch (error) {
    return next(error);
  }
});

function authenticateWebSocket(req, socket, head) {
  try {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }));
    const token = cookies[cookieName];
    if (!token) throw new Error('No token');
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(claims.id);
    if (!user) throw new Error('Account is no longer active');
    req.wsUser = user;
    return true;
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return false;
  }
}

module.exports = { router, authenticateWebSocket };
