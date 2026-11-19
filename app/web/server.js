const express = require('express');
const crypto = require('crypto');
const { SQSClient, SendMessageCommand, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
const db = require('./db');
const cache = require('./cache');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8080);
const QUEUE_URL = process.env.QUEUE_URL;
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 60);
const VERSION = process.env.APP_VERSION || 'dev';
const sqs = new SQSClient({});

let az = 'unknown';
async function discoverAz() {
  // ECS task metadata endpoint v4 tells us which AZ this Fargate task landed in
  const uri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!uri) return;
  try {
    const res = await fetch(`${uri}/task`);
    const meta = await res.json();
    az = meta.AvailabilityZone || az;
  } catch { /* not on ECS */ }
}

let dbReady = false;

// Liveness for the ALB and Route 53: the container is up and serving.
app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION, az }));

// Deeper readiness view used for debugging and the README evidence.
app.get('/status', async (req, res) => {
  let dbOk = false;
  try { await db.pool.query('SELECT 1'); dbOk = true; } catch { /* down */ }
  res.json({ version: VERSION, az, db: dbOk, cache: cache.isReady(), queue: Boolean(QUEUE_URL) });
});

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><html><head><title>Resilient Shop</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:3rem auto;padding:0 1rem;color:#222}
code{background:#f3f3f3;padding:2px 5px;border-radius:4px}</style></head><body>
<h1>Resilient Shop</h1>
<p>Served by a Fargate task in <b>${az}</b> &middot; version <code>${VERSION}</code></p>
<ul>
<li><code>GET /products</code> &ndash; catalogue (ElastiCache cache-aside over RDS)</li>
<li><code>POST /orders</code> &ndash; place an order (queued to SQS, processed by workers)</li>
<li><code>GET /orders/:id</code> &ndash; order status</li>
<li><code>GET /status</code> &ndash; dependency health</li>
</ul></body></html>`);
});

app.get('/products', async (req, res) => {
  const started = Date.now();
  const cached = await cache.get('products:all');
  if (cached) {
    return res.json({ source: 'cache', ms: Date.now() - started, az, products: cached });
  }
  try {
    const { rows } = await db.pool.query('SELECT id, name, price_cents FROM products ORDER BY id');
    await cache.set('products:all', rows, CACHE_TTL);
    res.json({ source: 'database', ms: Date.now() - started, az, products: rows });
  } catch (err) {
    console.error('products query failed', err.message);
    res.status(503).json({ error: 'catalogue temporarily unavailable' });
  }
});

app.get('/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  const key = `products:${id}`;
  const cached = await cache.get(key);
  if (cached) return res.json({ source: 'cache', product: cached });
  try {
    const { rows } = await db.pool.query('SELECT id, name, price_cents FROM products WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    await cache.set(key, rows[0], CACHE_TTL);
    res.json({ source: 'database', product: rows[0] });
  } catch (err) {
    res.status(503).json({ error: 'catalogue temporarily unavailable' });
  }
});

app.post('/orders', async (req, res) => {
  const productId = Number(req.body.productId || 1);
  const quantity = Number(req.body.quantity || 1);
  const id = crypto.randomUUID();
  try {
    await db.pool.query(
      'INSERT INTO orders (id, product_id, quantity) VALUES ($1, $2, $3)',
      [id, productId, quantity]
    );
    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ orderId: id, productId, quantity }),
    }));
    res.status(202).json({ orderId: id, status: 'PENDING' });
  } catch (err) {
    console.error('order intake failed', err.message);
    res.status(503).json({ error: 'could not accept order' });
  }
});

app.get('/orders/:id', async (req, res) => {
  try {
    const { rows } = await db.pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch {
    res.status(503).json({ error: 'unavailable' });
  }
});

// Load generator for the scaling demonstration: enqueues N synthetic orders in batches of 10.
app.post('/load', async (req, res) => {
  const count = Math.min(Number(req.query.count || 100), 5000);
  let sent = 0;
  try {
    for (let i = 0; i < count; i += 10) {
      const entries = [];
      for (let j = i; j < Math.min(i + 10, count); j++) {
        const orderId = crypto.randomUUID();
        await db.pool.query('INSERT INTO orders (id, product_id, quantity) VALUES ($1, 1, 1)', [orderId]);
        entries.push({ Id: String(j), MessageBody: JSON.stringify({ orderId, productId: 1, quantity: 1, synthetic: true }) });
      }
      await sqs.send(new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: entries }));
      sent += entries.length;
    }
    res.json({ enqueued: sent });
  } catch (err) {
    res.status(500).json({ enqueued: sent, error: err.message });
  }
});

async function start() {
  await discoverAz();
  cache.connect(); // non-blocking: the app degrades to direct RDS reads without Redis
  const server = app.listen(PORT, () => console.log(`web listening on ${PORT} in ${az}`));
  process.on('SIGTERM', () => {
    console.log('SIGTERM: draining');
    server.close(() => process.exit(0));
  });
  // Initialise the schema in the background, retrying so a task that starts mid-RDS-failover recovers
  for (let attempt = 1; !dbReady; attempt++) {
    try {
      await db.init();
      dbReady = true;
      console.log('database ready');
    } catch (err) {
      console.error(`db init attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

start();
