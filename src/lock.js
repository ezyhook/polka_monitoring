'use strict';

/**
 * Non-blocking mutex for heavy jobs (Phragmén child, full nominator scan).
 * A second caller gets BusyError instead of queueing — commands should
 * tell the user to retry, timers should simply skip this tick.
 */

class BusyError extends Error {
  constructor(label) {
    super(`${label} is already running — try again in a minute`);
    this.name = 'BusyError';
  }
}

class Lock {
  constructor(label) {
    this.label = label;
    this.busy  = false;
  }

  async run(fn) {
    if (this.busy) throw new BusyError(this.label);
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Lock, BusyError };
