'use strict';

/**
 * Storage.js driver implementation backed by Upstash's REST API instead of
 * ioredis/TCP. Matches storage.js's driver contract: connect, getAll,
 * writeBatch, publish, subscribe, quit.
 *
 * Uses UPSTASH_REDIS_URL (e.g. https://xxxx.upstash.io) and
 * UPSTASH_REDIS_TOKEN — the REST credentials from Upstash's console, not
 * the ioredis-style rediss:// connection string.
 *
 * Limitation: REST is stateless request/response, so there's no live
 * pub/sub — subscribe() is a no-op. That's fine here: each job process
 * runs once, calls init() (which reconciles from Redis), does its work,
 * and calls close(). It never needs live cross-instance sync mid-run.
 */
class UpstashRestDriver {
  constructor() {
    this.baseUrl = null;
    this.token = null;
  }

  /**
   * storage.js normally passes a single connection-string `url` here.
   * We ignore that (REST needs two separate values) and read the REST
   * credentials from env directly, since they don't fit into one string.
   */
  async connect() {
    this.baseUrl = (process.env.UPSTASH_REDIS_URL || '').replace(/\/+$/, '');
    this.token = process.env.UPSTASH_REDIS_TOKEN;
    if (!this.baseUrl || !this.token) {
      throw new Error(
        'UpstashRestDriver requires UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN env vars'
      );
    }
    // Cheap connectivity check so a bad token/url fails fast at init()
    // rather than silently on the first write.
    const res = await fetch(`${this.baseUrl}/ping`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(`Upstash REST ping failed: HTTP ${res.status}`);
    }
  }

  async _command(commandArray) {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commandArray),
    });
    const body = await res.json();
    if (!res.ok || body.error) {
      throw new Error(body.error || `Upstash REST HTTP ${res.status}`);
    }
    return body.result;
  }

  async getAll(namespace) {
    // HGETALL via REST returns a flat array: [field1, value1, field2, value2, ...]
    const flat = await this._command(['HGETALL', namespace]);
    const out = {};
    for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
    return out;
  }

  async writeBatch(namespace, ops) {
    // Uses the same single-command path as getAll (proven working via
    // reconcile logs) rather than the /pipeline endpoint, which was never
    // confirmed against a live instance and is the suspected cause of
    // writes silently not persisting.
    for (const { key, value } of ops) {
      const command =
        value === null ? ['HDEL', namespace, key] : ['HSET', namespace, key, value];
      const result = await this._command(command);
      console.log(
        `[upstash-rest driver] wrote ${namespace}.${key} (${value === null ? 'HDEL' : 'HSET'}) -> result: ${JSON.stringify(result)}`
      );
    }
  }

  async publish() {
    // No-op: REST has no persistent connection for pub/sub. Fine here
    // since syncEnabled is never turned on for these one-shot jobs.
  }

  async subscribe() {
    console.warn(
      '[upstash-rest driver] subscribe() is unsupported over REST — live cross-instance sync disabled'
    );
  }

  async quit() {
    // No persistent connection to close.
  }
}

module.exports = { UpstashRestDriver };
