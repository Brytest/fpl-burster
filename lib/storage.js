// src/lib/storage.js
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SAVE_DEBOUNCE_MS = 1000;
const RECONNECT_RETRY_MS = 10000;
const DEFAULT_BATCH_MS = 200;
const SWEEP_INTERVAL_MS = 30000;
const DEFAULT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function sanitizeKey(key) {
  return String(key).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// ---------------------------------------------------------------------------
// filter() query matching — $eq $ne $gt $gte $lt $lte $in $nin $exists $regex
// $contains, plus top-level $and/$or.
// ---------------------------------------------------------------------------

function getFieldValue(obj, fieldPath) {
  return fieldPath
    .split(".")
    .reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

// Immutably set a (possibly dotted/nested) field on obj by running it through
// `transform`. Each level along the path is shallow-copied so callers never
// mutate the caller's original object or any previously-stored env value.
// Missing intermediate levels are created as plain objects.
function setFieldValue(obj, fieldPath, transform) {
  const parts = fieldPath.split(".");
  const root =
    obj && typeof obj === "object"
      ? Array.isArray(obj)
        ? [...obj]
        : { ...obj }
      : {};
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nested = cursor[part];
    cursor[part] =
      nested && typeof nested === "object"
        ? Array.isArray(nested)
          ? [...nested]
          : { ...nested }
        : {};
    cursor = cursor[part];
  }
  const lastKey = parts[parts.length - 1];
  cursor[lastKey] = transform(cursor[lastKey]);
  return root;
}

const OPERATORS = {
  $eq: (a, b) => a === b,
  $ne: (a, b) => a !== b,
  $gt: (a, b) => a > b,
  $gte: (a, b) => a >= b,
  $lt: (a, b) => a < b,
  $lte: (a, b) => a <= b,
  $in: (a, b) => Array.isArray(b) && b.includes(a),
  $nin: (a, b) => Array.isArray(b) && !b.includes(a),
  $exists: (a, b) => (a !== undefined) === !!b,
  $regex: (a, b) => (b instanceof RegExp ? b : new RegExp(b)).test(String(a)),
  $contains: (a, b) =>
    (Array.isArray(a) || typeof a === "string") && a.includes(b),
};

function matchesCondition(fieldValue, condition) {
  if (
    condition === null ||
    typeof condition !== "object" ||
    Array.isArray(condition) ||
    condition instanceof RegExp
  ) {
    if (condition instanceof RegExp) return condition.test(String(fieldValue));
    return fieldValue === condition;
  }
  for (const [op, opVal] of Object.entries(condition)) {
    const check = OPERATORS[op];
    if (!check) throw new Error(`Unsupported filter operator "${op}"`);
    if (!check(fieldValue, opVal)) return false;
  }
  return true;
}

function matchesWhere(value, where) {
  if (!where) return true;
  for (const [field, condition] of Object.entries(where)) {
    if (field === "$and") {
      if (!condition.every((sub) => matchesWhere(value, sub))) return false;
      continue;
    }
    if (field === "$or") {
      if (!condition.some((sub) => matchesWhere(value, sub))) return false;
      continue;
    }
    if (!matchesCondition(getFieldValue(value, field), condition)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Human-readable / keyword TTL parsing
// ---------------------------------------------------------------------------

function getZonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zonedTimeToUtc(y, mo, d, h, mi, s, ms, timeZone) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  const zp = getZonedParts(guess, timeZone);
  const asUtcOfGuess = Date.UTC(
    zp.year,
    zp.month - 1,
    zp.day,
    zp.hour,
    zp.minute,
    zp.second,
    ms,
  );
  const offset = guess.getTime() - asUtcOfGuess;
  return new Date(guess.getTime() + offset);
}

function startOfDayInZone(date, tz, dayOffset = 0) {
  const p = getZonedParts(date, tz);
  return zonedTimeToUtc(p.year, p.month, p.day + dayOffset, 0, 0, 0, 0, tz);
}
function endOfDayInZone(date, tz, dayOffset = 0) {
  return new Date(startOfDayInZone(date, tz, dayOffset + 1).getTime() - 1);
}
function sameTimeNextDay(date, tz) {
  const p = getZonedParts(date, tz);
  return zonedTimeToUtc(
    p.year,
    p.month,
    p.day + 1,
    p.hour,
    p.minute,
    p.second,
    date.getMilliseconds(),
    tz,
  );
}
function startOfWeekInZone(date, tz, weekStartsOn = 1, weekOffset = 0) {
  const p = getZonedParts(date, tz);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const diff = (dow - weekStartsOn + 7) % 7;
  return startOfDayInZone(date, tz, -diff + weekOffset * 7);
}
function endOfWeekInZone(date, tz, weekStartsOn = 1, weekOffset = 0) {
  return new Date(
    startOfWeekInZone(date, tz, weekStartsOn, weekOffset + 1).getTime() - 1,
  );
}
function startOfMonthInZone(date, tz, monthOffset = 0) {
  const p = getZonedParts(date, tz);
  return zonedTimeToUtc(p.year, p.month + monthOffset, 1, 0, 0, 0, 0, tz);
}
function endOfMonthInZone(date, tz, monthOffset = 0) {
  return new Date(startOfMonthInZone(date, tz, monthOffset + 1).getTime() - 1);
}
function startOfYearInZone(date, tz, yearOffset = 0) {
  const p = getZonedParts(date, tz);
  return zonedTimeToUtc(p.year + yearOffset, 1, 1, 0, 0, 0, 0, tz);
}
function endOfYearInZone(date, tz, yearOffset = 0) {
  return new Date(startOfYearInZone(date, tz, yearOffset + 1).getTime() - 1);
}

const TTL_KEYWORDS = {
  eod: (now, tz) => endOfDayInZone(now, tz, 0),
  tomorrow: (now, tz) => sameTimeNextDay(now, tz),
  sot: (now, tz) => startOfDayInZone(now, tz, 1),
  eot: (now, tz) => endOfDayInZone(now, tz, 1),
  eow: (now, tz, weekStartsOn) => endOfWeekInZone(now, tz, weekStartsOn, 0),
  sow: (now, tz, weekStartsOn) => startOfWeekInZone(now, tz, weekStartsOn, 1),
  eom: (now, tz) => endOfMonthInZone(now, tz, 0),
  som: (now, tz) => startOfMonthInZone(now, tz, 1),
  eoy: (now, tz) => endOfYearInZone(now, tz, 0),
  soy: (now, tz) => startOfYearInZone(now, tz, 1),
};

const PHRASE_ALIASES = {
  "end of day": "eod",
  "end of today": "eod",
  "end of the day": "eod",
  "same time tomorrow": "tomorrow",
  "start of tomorrow": "sot",
  "beginning of tomorrow": "sot",
  "end of tomorrow": "eot",
  "end of week": "eow",
  "end of the week": "eow",
  "start of week": "sow",
  "start of the week": "sow",
  "next week": "sow",
  "end of month": "eom",
  "end of the month": "eom",
  "start of month": "som",
  "start of the month": "som",
  "next month": "som",
  "end of year": "eoy",
  "end of the year": "eoy",
  "start of year": "soy",
  "start of the year": "soy",
  "next year": "soy",
};

const DURATION_UNITS = {
  ms: 1,
  msec: 1,
  msecs: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60000,
  min: 60000,
  mins: 60000,
  minute: 60000,
  minutes: 60000,
  h: 3600000,
  hr: 3600000,
  hrs: 3600000,
  hour: 3600000,
  hours: 3600000,
  d: 86400000,
  day: 86400000,
  days: 86400000,
  w: 604800000,
  wk: 604800000,
  wks: 604800000,
  week: 604800000,
  weeks: 604800000,
  mo: 2592000000,
  mon: 2592000000,
  mons: 2592000000,
  month: 2592000000,
  months: 2592000000,
  y: 31536000000,
  yr: 31536000000,
  yrs: 31536000000,
  year: 31536000000,
  years: 31536000000,
};

function parseDuration(input) {
  const str = String(input).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str);

  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let match;
  let totalMs = 0;
  let matched = false;
  while ((match = re.exec(str))) {
    matched = true;
    const amount = parseFloat(match[1]);
    const unit = match[2];
    const multiplier = DURATION_UNITS[unit];
    if (multiplier == null)
      throw new Error(`Unknown TTL unit "${unit}" in "${input}"`);
    totalMs += amount * multiplier;
  }
  if (!matched) throw new Error(`Could not parse ttl "${input}"`);
  return totalMs;
}

function resolveTTL(ttl, options = {}) {
  if (ttl === null || ttl === undefined) return null;
  if (ttl instanceof Date) return ttl.getTime() - Date.now();
  if (typeof ttl === "number") return ttl;
  if (typeof ttl !== "string")
    throw new Error(
      `Invalid ttl value: ${ttl} (expected number, string, or Date)`,
    );

  const tz = options.timezone || DEFAULT_TZ;
  const weekStartsOn = options.weekStartsOn != null ? options.weekStartsOn : 1;

  let normalized = ttl.trim().toLowerCase().replace(/\s+/g, " ");
  if (PHRASE_ALIASES[normalized]) normalized = PHRASE_ALIASES[normalized];

  const anchor = TTL_KEYWORDS[normalized];
  if (anchor) {
    const now = new Date();
    return anchor(now, tz, weekStartsOn).getTime() - now.getTime();
  }

  return parseDuration(ttl);
}

// ---------------------------------------------------------------------------
// Backend drivers
// ---------------------------------------------------------------------------

class RedisDriver {
  constructor() {
    this.client = null;
    this.subClient = null;
  }

  async connect(url) {
    const Redis = require("ioredis");
    this.client = new Redis(url, {
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    await new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.client.off("ready", onReady);
        this.client.off("error", onError);
      };
      this.client.once("ready", onReady);
      this.client.once("error", onError);
    });
  }

  async getAll(namespace) {
    return this.client.hgetall(namespace);
  }

  async writeBatch(namespace, ops) {
    const pipeline = this.client.pipeline();
    for (const { key, value } of ops) {
      if (value === null) pipeline.hdel(namespace, key);
      else pipeline.hset(namespace, key, value);
    }
    await pipeline.exec();
  }

  async publish(namespace, message) {
    if (!this.client) return;
    await this.client.publish(`${namespace}:events`, message);
  }

  async subscribe(namespace, onMessage) {
    this.subClient = this.client.duplicate();
    await this.subClient.subscribe(`${namespace}:events`);
    this.subClient.on("message", (_channel, message) => onMessage(message));
  }

  async quit() {
    if (this.subClient) await this.subClient.quit().catch(() => {});
    if (this.client) await this.client.quit().catch(() => {});
  }
}

class MongoDriver {
  constructor(driverOptions = {}) {
    this.client = null;
    this.db = null;
    this.dbName = driverOptions.dbName || "storage";
    this.changeStream = null;
  }

  async connect(uri) {
    const { MongoClient } = require("mongodb");
    this.client = new MongoClient(uri);
    await this.client.connect();
    this.db = this.client.db(this.dbName);
  }

  _coll(namespace) {
    return this.db.collection(namespace);
  }

  async getAll(namespace) {
    const docs = await this._coll(namespace).find({}).toArray();
    const out = {};
    for (const d of docs) out[d._id] = d.value;
    return out;
  }

  async writeBatch(namespace, ops) {
    if (!ops.length) return;
    const operations = ops.map(({ key, value }) =>
      value === null
        ? { deleteOne: { filter: { _id: key } } }
        : {
            updateOne: {
              filter: { _id: key },
              update: { $set: { value } },
              upsert: true,
            },
          }
    );
    await this._coll(namespace).bulkWrite(operations, { ordered: false });
  }

  async publish() {}

  async subscribe(namespace, onMessage) {
    try {
      this.changeStream = this._coll(namespace).watch([], {
        fullDocument: "updateLookup",
      });
      this.changeStream.on("change", (change) => {
        if (change.operationType === "delete") {
          onMessage(
            JSON.stringify({
              origin: null,
              op: "delete",
              key: change.documentKey._id,
              env: null,
            })
          );
        } else if (change.fullDocument) {
          onMessage(
            JSON.stringify({
              origin: null,
              op: "set",
              key: change.fullDocument._id,
              env: JSON.parse(change.fullDocument.value),
            })
          );
        }
      });
    } catch (err) {
      console.warn(
        "[mongo driver] change streams unavailable (requires a replica set/Atlas) — live sync disabled:",
        err.message
      );
    }
  }

  async quit() {
    if (this.changeStream) await this.changeStream.close().catch(() => {});
    if (this.client) await this.client.close().catch(() => {});
  }
}

function createDriver(backend, driverOptions) {
  if (backend === "redis") return new RedisDriver();
  if (backend === "mongo") return new MongoDriver(driverOptions);
  throw new Error(
    `Unknown storage backend "${backend}". Use 'redis', 'mongo', or pass options.driver with a custom implementation.`
  );
}

function resolveConnectionString(backend) {
  if (backend === "redis")
    return process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || null;
  if (backend === "mongo")
    return process.env.MONGODB_URI || process.env.MONGO_URL || null;
  return null;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

class Storage {
  constructor(name, filePath, options = {}) {
    this.name = name;
    this.filePath = filePath;
    this.hashKey = `storage:${name}`;
    this.instanceId = crypto.randomUUID();

    this.ttl = options.ttl !== undefined ? options.ttl : null;
    this.timezone = options.timezone || null;
    this.weekStartsOn = options.weekStartsOn != null ? options.weekStartsOn : 1;
    this.tombstoneRetentionMs =
      options.tombstoneRetention != null
        ? resolveTTL(options.tombstoneRetention, {
            timezone: this.timezone,
            weekStartsOn: this.weekStartsOn,
          })
        : 3 * 24 * 60 * 60 * 1000;
    this.schema = options.schema || null;
    this.syncEnabled = !!options.sync;
    this.perKeyFiles = !!options.perKeyFiles;
    this.batchMs = options.batchMs != null ? options.batchMs : DEFAULT_BATCH_MS;

    this.backend = options.driver ? "custom" : options.backend || "redis";
    this.connectionString = options.connectionString || null;
    this.driver =
      options.driver || createDriver(this.backend, options.driverOptions);

    this.data = new Map();
    this.driverReady = false;
    this.ready = false;
    this.logger = options.logger || console.log.bind(console);

    this._dirty = false;
    this._dirtyKeys = new Set();
    this._saveTimer = null;
    this._perKeyTimers = new Map();
    this._reconnectTimer = null;
    this._sweepTimer = null;
    this._writeQueue = new Map();
    this._batchTimer = null;
    this._initPromise = null;
    this._connStr = null;
    this._hasBackend = false;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._init();
    return this._initPromise;
  }

  async _init() {
    this._ensureDir();
    this._loadLocal();

    this._connStr =
      this.connectionString ||
      (this.backend === "custom"
        ? undefined
        : resolveConnectionString(this.backend));

    this._hasBackend = !!(this._connStr || this.backend === "custom");

    if (this._connStr || this.backend === "custom") {
      await this._connectDriver();
    } else {
      console.warn(
        `[storage:${this.name}] no connection string for backend "${this.backend}", running local-only`
      );
    }

    this._sweepTimer = setInterval(() => this._sweep(), SWEEP_INTERVAL_MS);
    this._sweepTimer.unref?.();

    this.ready = true;
  }

  _ensureDir() {
    const dir = this.perKeyFiles ? this.filePath : path.dirname(this.filePath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _loadLocal() {
    try {
      if (this.perKeyFiles) {
        if (!fs.existsSync(this.filePath)) return;
        const files = fs
          .readdirSync(this.filePath)
          .filter((f) => f.endsWith(".json"));
        for (const f of files) {
          try {
            const raw = fs.readFileSync(path.join(this.filePath, f), "utf8");
            const record = JSON.parse(raw);
            if (record && typeof record.key === "string")
              this.data.set(record.key, record.env);
          } catch (err) {
            console.error(
              `[storage:${this.name}] skipping corrupt file ${f}:`,
              err.message
            );
          }
        }
      } else {
        if (!fs.existsSync(this.filePath)) return;
        const raw = fs.readFileSync(this.filePath, "utf8");
        const obj = raw.trim() ? JSON.parse(raw) : {};
        this.data = new Map(Object.entries(obj));
      }
    } catch (err) {
      console.error(
        `[storage:${this.name}] failed to load local data, starting empty:`,
        err.message
      );
      this.data = new Map();
    }
  }

  async _connectDriver() {
    try {
      await this.driver.connect(this._connStr);
      await this._reconcileWithDriver();
      this.driverReady = true;
      this.logger(
        `[storage:${this.name}] connected via "${this.backend}" driver, synced ${this.data.size} keys`
      );
      if (this.syncEnabled && typeof this.driver.subscribe === "function") {
        await this.driver.subscribe(this.hashKey, (msg) =>
          this._handleSyncMessage(msg)
        );
      }
    } catch (err) {
      console.error(
        `[storage:${this.name}] driver connect failed, falling back to local:`,
        err.message
      );
      this.driverReady = false;
      this._scheduleReconnect();
    }
  }

  _handleSyncMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || (msg.origin && msg.origin === this.instanceId)) return;

    if (msg.op === "set") {
      const existing = this.data.get(msg.key);
      if (existing && existing._ver >= msg.env._ver) return;
      this.data.set(msg.key, msg.env);
      this._markDirty(msg.key);
    } else if (msg.op === "delete") {
      const existing = this.data.get(msg.key);
      if (existing && msg.env && existing._ver >= msg.env._ver) return;
      const tombstone = msg.env || {
        v: null,
        _ver: (existing ? existing._ver : 0) + 1,
        _ts: Date.now(),
        _exp: null,
        _deleted: true,
      };
      this.data.set(msg.key, tombstone);
      this._markDirty(msg.key);
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (!this._connStr && this.backend !== "custom") return;
      await this._connectDriver();
    }, RECONNECT_RETRY_MS);
  }

  async _reconcileWithDriver() {
    const remoteRaw = await this.driver.getAll(this.hashKey);
    const remote = new Map();
    for (const [k, v] of Object.entries(remoteRaw)) {
      try {
        remote.set(k, JSON.parse(v));
      } catch {
        remote.set(k, { v, _ver: 1, _ts: Date.now(), _exp: null });
      }
    }

    const allKeys = new Set([...this.data.keys(), ...remote.keys()]);
    let pulled = 0;
    let pushed = 0;

    for (const key of allKeys) {
      const local = this.data.get(key);
      const rem = remote.get(key);

      if (local && !rem) {
        this._queueWrite(key, local._deleted ? null : local);
        pushed++;
        continue;
      }

      if (!local && rem) {
        this.data.set(key, rem);
        this._markDirty(key);
        pulled++;
        continue;
      }

      const localNewer =
        local._ts !== rem._ts ? local._ts > rem._ts : local._ver > rem._ver;
      if (localNewer) {
        this._queueWrite(key, local._deleted ? null : local);
        pushed++;
      } else if (rem._ts !== local._ts || rem._ver !== local._ver) {
        this.data.set(key, rem);
        this._markDirty(key);
        pulled++;
      }
    }

    if (pulled || pushed) {
      this.logger(
        `[storage:${this.name}] reconciled with backend: pulled ${pulled}, pushed ${pushed}`
      );
    }

    try {
      this._flushDirty(true);
    } catch (err) {
      console.error(
        `[storage:${this.name}] local flush after reconcile failed:`,
        err.message
      );
    }
  }

  _ensureReady() {
    if (!this.ready)
      throw new Error(
        `[storage:${this.name}] not initialized — call init() first`
      );
  }

  _wrap(key, value, opts = {}) {
    const existing = this.data.get(key);
    const ttlInput = opts.ttl !== undefined ? opts.ttl : this.ttl;
    const ttlMs = resolveTTL(ttlInput, {
      timezone: this.timezone,
      weekStartsOn: this.weekStartsOn,
    });
    return {
      v: value,
      _ver: existing ? existing._ver + 1 : 1,
      _ts: Date.now(),
      _exp: ttlMs != null ? Date.now() + ttlMs : null,
    };
  }

  _isExpired(env) {
    return !!(env && env._exp && env._exp <= Date.now());
  }

  _sweep() {
    const now = Date.now();
    for (const [key, env] of this.data) {
      if (env._deleted) {
        if (now - env._ts > this.tombstoneRetentionMs) {
          this.data.delete(key);
          this._markDirty(key);
        }
      } else if (env._exp && env._exp <= now) {
        this._deleteKey(key);
      }
    }
  }

  get(key, defaultValue) {
    this._ensureReady();
    const env = this.data.get(key);
    if (!env || env._deleted) return defaultValue;
    if (this._isExpired(env)) {
      this._deleteKey(key);
      return defaultValue;
    }
    return env.v;
  }

  getMeta(key) {
    this._ensureReady();
    const env = this.data.get(key);
    if (!env || env._deleted || this._isExpired(env)) return undefined;
    return { version: env._ver, updatedAt: env._ts, expiresAt: env._exp };
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  getAll() {
    this._ensureReady();
    const out = {};
    for (const [k, env] of this.data)
      if (!env._deleted && !this._isExpired(env)) out[k] = env.v;
    return out;
  }

  keys() {
    this._ensureReady();
    return [...this.data.keys()].filter((k) => {
      const env = this.data.get(k);
      return !env._deleted && !this._isExpired(env);
    });
  }

  filter(query = {}) {
    this._ensureReady();
    const { where, limit, withKeys } = query;
    const results = [];
    for (const [key, env] of this.data) {
      if (env._deleted || this._isExpired(env)) continue;
      if (!matchesWhere(env.v, where)) continue;
      results.push(withKeys ? { key, value: env.v } : env.v);
      if (limit && results.length >= limit) break;
    }
    return results;
  }

  // set(key, value, opts?)                       — replace the whole record
  // set(key, fieldPath, updaterFn, opts?)         — immutably update one
  //                                                  (possibly dotted) field,
  //                                                  e.g. set(id, "history",
  //                                                  prev => [...(prev||[]), x])
  //
  // The two forms are disambiguated by argument shape: field-path mode only
  // triggers when the 2nd arg is a string AND the 3rd arg is a function.
  // A literal string value passed as the 2nd arg with no function afterwards
  // is always treated as a whole-value set, so existing callers are unaffected.
  async set(key, ...rest) {
    this._ensureReady();

    if (rest.length >= 2 && typeof rest[0] === "string" && typeof rest[1] === "function") {
      const [fieldPath, updater, opts = {}] = rest;
      const current = this.get(key);
      const base =
        current !== undefined
          ? current
          : opts.default !== undefined
          ? opts.default
          : {};
      const next = setFieldValue(base, fieldPath, updater);
      return this._setWhole(key, next, opts);
    }

    const [value, opts = {}] = rest;
    return this._setWhole(key, value, opts);
  }

  async _setWhole(key, value, opts = {}) {
    this._ensureReady();
    if (this.schema) this.schema(key, value);

    const env = this._wrap(key, value, opts);
    this.data.set(key, env);
    this._markDirty(key);

    this._queueWrite(key, env);
    if (this.syncEnabled) this._publish("set", key, env);

    return value;
  }

  _deleteKey(key) {
    const existing = this.data.get(key);
    const existed = !!existing && !existing._deleted;
    const tombstone = {
      v: null,
      _ver: existing ? existing._ver + 1 : 1,
      _ts: Date.now(),
      _exp: null,
      _deleted: true,
    };
    this.data.set(key, tombstone);
    this._markDirty(key);

    this._queueWrite(key, null);
    if (this.syncEnabled) this._publish("delete", key, tombstone);

    return existed;
  }

  async delete(key) {
    this._ensureReady();
    return this._deleteKey(key);
  }

  async save(dataOrFn, onSuccess = null, onError = null) {
    this._ensureReady();

    try {
      const previous = this.getAll();
      const next =
        typeof dataOrFn === "function" ? dataOrFn(previous) : dataOrFn;

      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        throw new Error(
          `[storage:${this.name}] save() requires a plain object of key -> value pairs`
        );
      }

      const nextKeys = new Set(Object.keys(next));
      const prevKeys = new Set(this.data.keys());

      if (this.schema) {
        for (const key of nextKeys) this.schema(key, next[key]);
      }

      for (const key of nextKeys) {
        const value = next[key];
        const env = this._wrap(key, value);
        this.data.set(key, env);
        this._markDirty(key);
        this._queueWrite(key, env);
        if (this.syncEnabled) this._publish("set", key, env);
      }

      for (const key of prevKeys) {
        if (nextKeys.has(key)) continue;
        if (this.data.get(key)?._deleted) continue;
        this._deleteKey(key);
      }

      await this._flushWriteQueue();
      this._flushDirty(true);

      if (typeof onSuccess === "function") onSuccess(next);

      return next;
    } catch (err) {
      if (typeof onError === "function") return onError(err);
      throw err;
    }
  }

  _publish(op, key, env) {
    if (!this.driverReady || typeof this.driver.publish !== "function") return;
    const msg = JSON.stringify({ origin: this.instanceId, op, key, env });
    this.driver
      .publish(this.hashKey, msg)
      .catch((err) =>
        console.error(`[storage:${this.name}] publish failed:`, err.message)
      );
  }

  _queueWrite(key, env) {
    this._writeQueue.set(key, env);
    if (this._batchTimer) return;
    this._batchTimer = setTimeout(() => {
      this._flushWriteQueue().catch((err) => {
        console.error(
          `[storage:${this.name}] background write flush failed:`,
          err.message
        );
      });
    }, this.batchMs);
  }

  async _flushWriteQueue() {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    if (!this._writeQueue.size) return;

    if (!this.driverReady) {
      this._writeQueue.clear();
      if (this._hasBackend) {
        const err = new Error(
          `[storage:${this.name}] cannot flush write queue: backend driver "${this.backend}" is not connected`
        );
        this._scheduleReconnect();
        throw err;
      }
      return;
    }

    const batch = new Map(this._writeQueue);
    this._writeQueue.clear();
    const ops = [...batch].map(([key, env]) => ({
      key,
      value: env === null ? null : JSON.stringify(env),
    }));

    try {
      await this.driver.writeBatch(this.hashKey, ops);
      this.logger(
        `[storage:${this.name}] flushed ${ops.length} write(s) to backend`
      );
    } catch (err) {
      console.error(
        `[storage:${this.name}] batched write failed:`,
        err.message
      );
      this.driverReady = false;
      this._scheduleReconnect();
      throw err;
    }
  }

  _markDirty(key) {
    if (this.perKeyFiles) {
      this._dirtyKeys.add(key);
      this._schedulePerKeySave(key);
    } else {
      this._dirty = true;
      this._scheduleSave();
    }
  }

  _scheduleSave(immediate = false) {
    if (immediate) {
      this._flushSingleFile();
      return;
    }
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      try {
        this._flushSingleFile();
      } catch (err) {
        console.error(
          `[storage:${this.name}] deferred local save failed:`,
          err.message
        );
      }
    }, SAVE_DEBOUNCE_MS);
  }

  _flushSingleFile() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._dirty) return;
    try {
      const tmpPath = `${this.filePath}.tmp`;
      const obj = Object.fromEntries(this.data);
      fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
      fs.renameSync(tmpPath, this.filePath);
      this._dirty = false;
    } catch (err) {
      console.error(`[storage:${this.name}] local save failed:`, err.message);
      throw err;
    }
  }

  _schedulePerKeySave(key) {
    if (this._perKeyTimers.has(key)) return;
    const timer = setTimeout(() => {
      try {
        this._flushKey(key);
      } catch (err) {
        console.error(
          `[storage:${this.name}] deferred per-key save failed for "${key}":`,
          err.message
        );
      }
    }, SAVE_DEBOUNCE_MS);
    this._perKeyTimers.set(key, timer);
  }

  _flushKey(key) {
    this._perKeyTimers.delete(key);
    if (!this._dirtyKeys.has(key)) return;
    const file = path.join(this.filePath, `${sanitizeKey(key)}.json`);
    const env = this.data.get(key);
    try {
      if (env === undefined) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ key, env }, null, 2));
        fs.renameSync(tmp, file);
      }
      this._dirtyKeys.delete(key);
    } catch (err) {
      console.error(
        `[storage:${this.name}] per-key save failed for "${key}":`,
        err.message
      );
      throw err;
    }
  }

  _flushDirty(immediate = false) {
    if (this.perKeyFiles) {
      const errors = [];
      for (const key of [...this._dirtyKeys]) {
        try {
          this._flushKey(key);
        } catch (err) {
          errors.push(err);
        }
      }
      if (immediate && errors.length) {
        throw new Error(
          `[storage:${this.name}] failed to persist ${errors.length} key file(s) to disk: ${errors[0].message}`
        );
      }
    } else {
      this._scheduleSave(immediate);
    }
  }

  _flushAll() {
    if (this.perKeyFiles) {
      for (const key of [...this._dirtyKeys]) {
        try {
          this._flushKey(key);
        } catch (err) {
          console.error(
            `[storage:${this.name}] flushAll: per-key save failed for "${key}":`,
            err.message
          );
        }
      }
    } else {
      this._flushSingleFile();
    }
  }

  async close() {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
    }
    try {
      await this._flushWriteQueue();
    } catch (err) {
      console.error(
        `[storage:${this.name}] flush write queue on close failed:`,
        err.message
      );
    }
    try {
      this._flushAll();
    } catch (err) {
      console.error(
        `[storage:${this.name}] local flush on close failed:`,
        err.message
      );
    }
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.driver && typeof this.driver.quit === "function")
      await this.driver.quit().catch(() => {});
  }
}

const instances = new Map();
let exitHandlersBound = false;

function flushAllInstances() {
  for (const store of instances.values()) {
    try {
      store._flushAll();
    } catch (err) {
      console.error(
        `[storage:${store.name}] flush on exit failed:`,
        err.message
      );
    }
  }
}

function bindGlobalExitHandlers() {
  if (exitHandlersBound) return;
  exitHandlersBound = true;
  process.on("exit", flushAllInstances);

  const gracefulThenForceExit = () => {
    flushAllInstances();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", gracefulThenForceExit);
  process.on("SIGTERM", gracefulThenForceExit);
}

function getStorage(name, filePath, options = {}) {
  bindGlobalExitHandlers();
  if (!filePath) filePath = path.join("data", `${name}.json`);
  const key = `${name}::${filePath}`;
  if (instances.has(key)) return instances.get(key);
  const store = new Storage(name, filePath, options);
  instances.set(key, store);
  return store;
}

module.exports = { getStorage, resolveTTL };
