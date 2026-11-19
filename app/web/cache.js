const { createClient } = require('redis');

let client;
let ready = false;

async function connect() {
  if (!process.env.REDIS_HOST) {
    console.warn('REDIS_HOST not set - running without cache');
    return;
  }
  client = createClient({
    socket: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
    },
  });
  client.on('ready', () => { ready = true; console.log('redis ready'); });
  client.on('end', () => { ready = false; });
  client.on('error', (err) => { ready = false; console.error('redis error', err.message); });
  await client.connect().catch((err) => console.error('redis connect failed', err.message));
}

// Cache-aside: a cache failure must never take the request down, it just falls through to RDS.
async function get(key) {
  if (!ready) return null;
  try {
    const v = await client.get(key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

async function set(key, value, ttlSeconds) {
  if (!ready) return;
  try {
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch { /* ignore */ }
}

async function del(key) {
  if (!ready) return;
  try { await client.del(key); } catch { /* ignore */ }
}

module.exports = { connect, get, set, del, isReady: () => ready };
