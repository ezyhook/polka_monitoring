'use strict';

const { Level } = require('level');
const path = require('path');
const fs = require('fs');

/**
 * Persistent key-value store backed by LevelDB.
 * All values are JSON-serialised, supporting objects, arrays and primitives.
 */
class StateManager {
  constructor(dbPath) {
    this.dbPath = dbPath || './data/state.db';
    this.db = null;
  }

  async open() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Level(this.dbPath, { valueEncoding: 'json' });
    await this.db.open();
    console.log(`[State] LevelDB opened: ${this.dbPath}`);
  }

  async close() {
    if (this.db) await this.db.close();
  }

  async get(key, defaultValue = null) {
    try {
      const val = await this.db.get(key);
      return val ?? defaultValue;
    } catch (e) {
      if (e.code === 'LEVEL_NOT_FOUND') return defaultValue;
      throw e;
    }
  }

  async set(key, value) {
    await this.db.put(key, value);
  }

  async del(key) {
    try {
      await this.db.del(key);
    } catch (e) {
      if (e.code !== 'LEVEL_NOT_FOUND') throw e;
    }
  }

  /** Returns all key-value pairs whose key starts with the given prefix. */
  async getAll(prefix = '') {
    const results = [];
    for await (const [key, value] of this.db.iterator()) {
      if (!prefix || key.startsWith(prefix)) {
        results.push({ key, value });
      }
    }
    return results;
  }
}

module.exports = StateManager;
