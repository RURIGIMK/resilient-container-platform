const os = require('os');
const { Pool } = require('pg');
const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require('@aws-sdk/client-sqs');

const QUEUE_URL = process.env.QUEUE_URL;
const WORK_MS = Number(process.env.WORK_MS || 1000); // simulated per-order processing time
const WORKER_ID = process.env.HOSTNAME || os.hostname();

const sqs = new SQSClient({});
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'shop',
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 4,
});

let running = true;
process.on('SIGTERM', () => {
  // ECS sends SIGTERM on scale-in; finish the in-flight batch, then exit.
  // Unfinished messages become visible again after the visibility timeout.
  console.log('SIGTERM received, finishing current batch');
  running = false;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processMessage(msg) {
  const order = JSON.parse(msg.Body);
  await sleep(WORK_MS); // e.g. payment capture, inventory reservation, email
  await pool.query(
    `UPDATE orders SET status = 'PROCESSED', processed_at = now(), processed_by = $2 WHERE id = $1`,
    [order.orderId, WORKER_ID]
  );
  await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: msg.ReceiptHandle }));
}

async function loop() {
  console.log(`worker ${WORKER_ID} polling ${QUEUE_URL}`);
  let processed = 0;
  while (running) {
    try {
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20, // long polling: cheap and responsive
      }));
      for (const msg of Messages) {
        try {
          await processMessage(msg);
          processed++;
        } catch (err) {
          // Leave it on the queue; after maxReceiveCount it lands in the DLQ
          console.error('failed to process message', err.message);
        }
      }
      if (Messages.length) console.log(`processed batch of ${Messages.length} (total ${processed})`);
    } catch (err) {
      console.error('receive failed', err.message);
      await sleep(5000);
    }
  }
  await pool.end();
  console.log(`worker exiting after ${processed} messages`);
  process.exit(0);
}

loop();
