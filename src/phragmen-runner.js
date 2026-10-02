'use strict';

/**
 * Runs the Phragmén analysis in a short-lived child process and returns
 * the result as a Promise.  The child exits when done, freeing all the
 * ~500 MB of working memory without growing the monitor's own heap.
 */

const { fork } = require('child_process');
const path      = require('path');

const WORKER = path.join(__dirname, 'phragmen-worker.js');

/**
 * @param {string}  rpcEndpoint       - Asset Hub WSS endpoint (staking lives here post-AHM)
 * @param {string}  validatorAddress  - SS58 stash address
 * @param {boolean} forceRefresh      - Pass true to skip all caches
 * @param {number}  [timeoutMs]       - Kill the child after this many ms (default 10 min)
 * @returns {Promise<object>}         - analyzeSlotPosition() result
 */
function runPhragmenInChild(rpcEndpoint, validatorAddress, forceRefresh = false, timeoutMs = 10 * 60_000) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [], {
      // Give the child its own 1.5 GB heap; independent of the monitor process.
      execArgv: ['--max-old-space-size=1536'],
      // Inherit stdout/stderr so PM2 captures child logs normally.
      // Set PHRAGMEN_QUIET=1 to suppress child output.
      silent: !!process.env.PHRAGMEN_QUIET,
    });

    let settled = false;

    const kill = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('[PhragmenRunner] Worker timed out after ' + Math.round(timeoutMs / 60_000) + ' min'));
      }
    }, timeoutMs);

    child.on('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      if (msg.ok) {
        resolve(msg.result);
      } else {
        reject(new Error(msg.error || 'Phragmén worker failed'));
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(kill);
        reject(new Error(`[PhragmenRunner] Worker exited unexpectedly (code=${code}, signal=${signal})`));
      }
    });

    // Send work to child
    child.send({ rpcEndpoint, validatorAddress, forceRefresh });
  });
}

module.exports = { runPhragmenInChild };
