const express = require('express');
const crypto = require('node:crypto');
const PDFDocument = require('pdfkit');
const db = require('./db');

const router = express.Router();
const eventTypes = ['Gas Leak', 'Fire Detected', 'Cleared', 'SMS Sent', 'System'];
const gasThreshold = configuredInteger('GAS_THRESHOLD', 1800, 100, 4095);
const detectionDelay = configuredInteger('DETECTION_DELAY_SECONDS', 5, 1, 60);

function configuredInteger(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

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
  const values = [];
  if (query.from) {
    if (!validateDate(query.from)) throw new Error('Invalid from date');
    values.push(query.from);
    conditions.push(`created_at::date >= $${values.length}::date`);
  }
  if (query.to) {
    if (!validateDate(query.to)) throw new Error('Invalid to date');
    values.push(query.to);
    conditions.push(`created_at::date <= $${values.length}::date`);
  }
  if (query.type) {
    if (!eventTypes.includes(query.type)) throw new Error('Invalid event type');
    values.push(query.type);
    conditions.push(`event_type = $${values.length}`);
  }
  if (query.from && query.to && query.from > query.to) {
    throw new Error('From date must be on or before the to date');
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    values
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
    if (client.readyState === 1) client.send(payload);
  }
}

async function recordEvent(app, event) {
  const { rows } = await db.query(`
    INSERT INTO events (event_type, gas_value, actions, details)
    VALUES ($1, $2, $3, $4) RETURNING *
  `, [
    event.event_type,
    event.gas_value ?? null,
    JSON.stringify(Array.isArray(event.actions) ? event.actions : []),
    event.details || ''
  ]);
  const saved = rows[0];
  publish(app, { type: 'event', event: saved });
  return saved;
}

router.get('/status', asyncHandler(async (req, res) => {
  const [latestResult, pointsResult] = await Promise.all([
    db.query('SELECT * FROM readings ORDER BY id DESC LIMIT 1'),
    db.query(`
      SELECT id, gas_value, flame_detected, status, created_at
      FROM (SELECT * FROM readings ORDER BY id DESC LIMIT 60) AS recent
      ORDER BY id ASC
    `)
  ]);
  const latest = latestResult.rows[0];
  const lastSeen = latest ? `${latest.created_at.replace(' ', 'T')}Z` : null;
  const online = Boolean(latest && Date.now() - Date.parse(lastSeen) < 15000);
  res.json({
    online, lastSeen,
    reading: latest || null,
    threshold: gasThreshold,
    points: pointsResult.rows
  });
}));

router.get('/history', asyncHandler(async (req, res) => {
  let filters;
  try {
    filters = getHistoryFilters(req.query);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const page = Number.parseInt(req.query.page || '1', 10);
  if (!Number.isInteger(page) || page < 1 || page > 100000) return res.status(400).json({ error: 'Invalid page' });
  const limit = 20;
  const countResult = await db.query(`SELECT COUNT(*)::int AS count FROM events ${filters.where}`, filters.values);
  const values = [...filters.values, limit, (page - 1) * limit];
  const itemsResult = await db.query(`
    SELECT * FROM events ${filters.where} ORDER BY id DESC LIMIT $${values.length - 1} OFFSET $${values.length}
  `, values);
  const total = countResult.rows[0].count;
  res.json({ items: itemsResult.rows, page, pages: Math.max(1, Math.ceil(total / limit)), total });
}));

router.get('/history/export', asyncHandler(async (req, res) => {
  let filters;
  try {
    filters = getHistoryFilters(req.query);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const items = (await db.query(
    `SELECT * FROM events ${filters.where} ORDER BY id DESC LIMIT 10000`, filters.values
  )).rows;
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
      `Filters: ${req.query.from || 'any date'} to ${req.query.to || 'any date'} · ${req.query.type || 'all event types'} · ${items.length} events`
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
}));

router.get('/device/config', requireDeviceKey, (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    gas_threshold: gasThreshold,
    detection_delay: detectionDelay
  });
});

router.post('/device/data', requireDeviceKey, asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!isIntegerInRange(body.gas_value, 0, 4095) || typeof body.flame_detected !== 'boolean' ||
      !['Normal', 'Gas Leak', 'Fire Detected'].includes(body.status)) {
    return res.status(400).json({ error: 'Invalid gas_value, flame_detected, or status' });
  }
  const states = ['fan_on', 'pump_on', 'buzzer_on', 'regulator_open'];
  if (!states.every((key) => typeof body[key] === 'boolean')) {
    return res.status(400).json({ error: 'All device state fields must be booleans' });
  }
  const { rows } = await db.query(`
    INSERT INTO readings (gas_value, flame_detected, status, fan_on, pump_on, buzzer_on, regulator_open)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, gas_value, flame_detected, status,
      fan_on, pump_on, buzzer_on, regulator_open, created_at
  `, [body.gas_value, Number(body.flame_detected), body.status,
    Number(body.fan_on), Number(body.pump_on), Number(body.buzzer_on), Number(body.regulator_open)]);
  const reading = rows[0];
  publish(req.app, { type: 'reading', reading });
  res.status(201).json({ ok: true, id: reading.id });
}));

router.post('/device/event', requireDeviceKey, asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!eventTypes.slice(0, 3).includes(body.event_type) ||
      !isIntegerInRange(body.gas_value, 0, 4095) ||
      !Array.isArray(body.actions) || body.actions.length > 12 ||
      !body.actions.every((action) => typeof action === 'string' && action.length <= 80)) {
    return res.status(400).json({ error: 'Invalid event type, gas value, or actions' });
  }
  const event = await recordEvent(req.app, body);
  if (['Gas Leak', 'Fire Detected'].includes(body.event_type)) {
    await recordEvent(req.app, {
      event_type: 'SMS Sent',
      gas_value: body.gas_value,
      actions: ['SMS handled by ESP32 GSM module'],
      details: 'SMS dispatch requested by on-device alarm logic'
    });
  }
  return res.status(201).json({ ok: true, id: event.id });
}));

module.exports = { router };
