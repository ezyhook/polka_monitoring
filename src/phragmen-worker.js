'use strict';

/**
 * Phragmén child-process worker.
 *
 * Spawned by phragmen-runner.js via child_process.fork().
 * Receives a single IPC message with connection params, runs the full
 * analyzeSlotPosition(), sends the result back, then exits — releasing
 * all the memory used by the analysis (nominatorVotes, filteredNominators,
 * ledgerMap, etc.) without burdening the long-running monitor process.
 */

const { ApiPromise, WsProvider } = require('@polkadot/api');
const { analyzeSlotPosition }    = require('./phragmen');

process.on('message', async (msg) => {
  const { rpcEndpoint, validatorAddress, forceRefresh } = msg;

  let api;
  try {
    const provider = new WsProvider(rpcEndpoint);
    api = await ApiPromise.create({ provider });
    await api.isReady;

    const result = await analyzeSlotPosition(api, validatorAddress, forceRefresh);
    process.send({ ok: true, result });
  } catch (err) {
    process.send({ ok: false, error: err.message });
  } finally {
    try { if (api) await api.disconnect(); } catch (_) {}
    // Give IPC a moment to flush, then exit
    setTimeout(() => process.exit(0), 500);
  }
});
