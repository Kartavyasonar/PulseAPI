// PulseAPI — Kafka Request Log Consumer
//
// Subscribes to the 'request-logs' topic and batch-inserts log entries
// into Postgres every FLUSH_INTERVAL_MS (default 1 000 ms) or when the
// local buffer hits BATCH_SIZE (default 500), whichever comes first.
//
// Why a separate consumer process rather than writing from the gateway?
//   - The gateway is never blocked waiting for a Postgres ack.
//   - Kafka retains messages during a DB outage; on recovery the consumer
//     drains the backlog automatically.
//   - Consumer lag is a Kafka-native observable metric (k6 / kminion /
//     Prometheus kafka_consumer_group_lag) — you get back-pressure
//     visibility for free.
//   - Additional consumers (e.g. an analytics fan-out, a SIEM feed) can
//     join the same consumer group or form a new one without touching the
//     gateway or this service.

require('dotenv').config();
const { Kafka, logLevel } = require('kafkajs');
const { Pool }            = require('pg');

const BROKERS        = (process.env.KAFKA_BROKERS  || 'kafka:9092').split(',');
const TOPIC          = process.env.KAFKA_TOPIC      || 'request-logs';
const GROUP_ID       = process.env.KAFKA_GROUP_ID   || 'pulseapi-log-writer';
const BATCH_SIZE     = parseInt(process.env.BATCH_SIZE     || '500', 10);
const FLUSH_INTERVAL = parseInt(process.env.FLUSH_INTERVAL || '1000', 10);

const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://pulse:pulse@postgres:5432/pulseapi',
  max: 5,
});

const kafka = new Kafka({
  clientId: 'pulseapi-log-consumer',
  brokers: BROKERS,
  logLevel: logLevel.WARN,
  retry: { retries: 10, initialRetryTime: 500, maxRetryTime: 30_000 },
});

const consumer = kafka.consumer({ groupId: GROUP_ID });

let buffer = [];
let flushTimer = null;

async function flushBuffer() {
  if (!buffer.length) return;
  const entries = buffer.splice(0);

  try {
    const vals = entries.map((_, i) => {
      const b = i * 11;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`;
    });
    const params = entries.flatMap(e => [
      e.timestamp || new Date().toISOString(),
      e.method    || 'GET',
      e.path      || '/',
      e.routeId   || null,
      e.upstream  || null,
      e.clientIp  || null,
      e.apiKey    || null,
      e.tenantId  || null,
      e.status    || null,
      e.latency   || null,
      e.traceId   || null,
    ]);

    await db.query(
      `INSERT INTO requests(timestamp,method,path,route_id,upstream,client_ip,api_key,tenant_id,status_code,latency_ms,trace_id)
       VALUES ${vals.join(',')}
       ON CONFLICT DO NOTHING`,
      params
    );
    console.log(`[consumer] flushed ${entries.length} records to postgres`);
  } catch (err) {
    console.error('[consumer] postgres flush error:', err.message);
    // re-buffer on failure so records aren't lost on transient DB errors
    buffer.unshift(...entries);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushBuffer();
  }, FLUSH_INTERVAL);
}

async function run() {
  await consumer.connect();
  console.log(`[consumer] connected — topic: ${TOPIC} group: ${GROUP_ID}`);

  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      let entry;
      try {
        entry = JSON.parse(message.value.toString());
      } catch {
        console.warn('[consumer] malformed message, skipping');
        return;
      }

      buffer.push(entry);

      if (buffer.length >= BATCH_SIZE) {
        clearTimeout(flushTimer);
        flushTimer = null;
        await flushBuffer();
      } else {
        scheduleFlush();
      }
    },
  });
}

async function shutdown(signal) {
  console.log(`[consumer] ${signal} received — draining buffer…`);
  clearTimeout(flushTimer);
  await flushBuffer();
  await consumer.disconnect();
  await db.end();
  console.log('[consumer] clean shutdown');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

run().catch(err => {
  console.error('[consumer] fatal:', err);
  process.exit(1);
});
