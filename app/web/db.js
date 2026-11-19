const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'shop',
  // RDS PostgreSQL enforces TLS by default (rds.force_ssl=1)
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 5000,
});

const PRODUCTS = [
  ['Wireless Headphones', 7999],
  ['Mechanical Keyboard', 12999],
  ['USB-C Hub', 3499],
  ['4K Monitor', 32999],
  ['Laptop Stand', 4599],
  ['Webcam 1080p', 5999],
];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      product_id INTEGER REFERENCES products(id),
      quantity INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ,
      processed_by TEXT
    );
  `);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM products');
  if (rows[0].n === 0) {
    for (const [name, price] of PRODUCTS) {
      await pool.query('INSERT INTO products (name, price_cents) VALUES ($1, $2)', [name, price]);
    }
  }
}

module.exports = { pool, init };
