const path = require('node:path');
const fs = require('node:fs');
const { Pool, types } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured for PostgreSQL');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
types.setTypeParser(20, Number);

async function query(text, values = []) {
  return pool.query(text, values);
}

async function initialize() {
  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  await pool.query(fs.readFileSync(schemaPath, 'utf8'));
}

module.exports = { initialize, query, close: () => pool.end() };
