// Kafka-based async request logging pipeline
//
// Architecture decision:
//   Instead of writing directly to Postgres in the 500ms buffer,
//   we publish to a Kafka topic ("request-logs"). A separate consumer
//   process (kafka-consumer/) subscribes and batch-inserts to Postgres.
//
// Why async via Kafka vs. direct write?
//   - Gateway latency: Postgres inserts are off the critical path entirely.
//     Even with the 500ms buffer, a slow Postgres (index rebuild, vacuum,
//     network blip) would stall the flush loop. With Kafka the gateway
//     just appends to a durable log; the consumer absorbs back-pressure.
//   - Durability: Kafka retains messages even if Postgres is briefly down.
//     No request logs are dropped during a DB maintenance window.
//   - Fan-out: additional consumers (analytics, alerting, audit trail)
//     can subscribe to the same topic without touching the gateway.
//   - Replay: reprocess historical requests against a schema migration or
//     a new analytics table without re-running load tests.
//
// Falls back silently to the legacy direct-Postgres logger when Kafka is
// unavailable (KAFKA_BROKERS not set, or broker unreachable at startup).
// This keeps the gateway working in local dev without a Kafka cluster.

const { Kafka, Partitioners, logLevel } = require('kafkajs');

const TOPIC   = process.env.KAFKA_TOPIC   || 'request-logs';
const BROKERS = (process.env.KAFKA_BROKERS || '').split(',').filter(Boolean);

class KafkaRequestLogger {
  constructor() {
    this.producer = null;
    this.ready    = false;
    this._initPromise = null;
  }

  async init() {
    if (!BROKERS.length) {
      console.log('[kafka-logger] KAFKA_BROKERS not set — Kafka logging disabled');
      return;
    }

    const kafka = new Kafka({
      clientId: 'pulseapi-gateway',
      brokers: BROKERS,
      logLevel: logLevel.WARN,
      retry: { retries: 3, initialRetryTime: 300 },
    });

    this.producer = kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
      allowAutoTopicCreation: true,
    });

    try {
      await this.producer.connect();
      this.ready = true;
      console.log(`[kafka-logger] connected → topic: ${TOPIC} brokers: ${BROKERS.join(',')}`);
    } catch (err) {
      console.warn(`[kafka-logger] could not connect (${err.message}) — falling back to direct Postgres writes`);
      this.producer = null;
    }
  }

  // Publish a single log entry as a JSON message.
  // Key = route_id so logs for the same route land on the same partition
  // (preserves ordering within a route, enables per-route consumer scaling).
  async publish(entry) {
    if (!this.ready || !this.producer) return false;
    try {
      await this.producer.send({
        topic: TOPIC,
        messages: [{
          key:   entry.routeId || '__gateway__',
          value: JSON.stringify(entry),
        }],
      });
      return true;
    } catch (err) {
      console.error('[kafka-logger] publish error:', err.message);
      return false;
    }
  }

  async disconnect() {
    if (this.producer) await this.producer.disconnect().catch(() => {});
  }
}

// Singleton — one producer connection per gateway process
const kafkaLogger = new KafkaRequestLogger();

module.exports = { kafkaLogger, TOPIC };
