'use strict';

/**
 * NPoS election: Sequential Phragmén + balancing, ported from Substrate's
 * sp-npos-elections (phragmen.rs, balancing.rs). Floats instead of rational
 * fixed point — fine for ranking and stake estimates.
 *
 * Input:
 *   targets  — array of candidate ids
 *   voters   — array of { id, stake, targets: [candidate ids] }
 *              (validators are voters too: self-vote with their own stake)
 *   toElect  — number of winners
 *
 * Output: { winners: [{ id, support }] sorted by support desc, backers(id) → [{ voter, weight }] }
 */

function seqPhragmen(targets, voters, toElect, { balancingIterations = 10, tolerance = 0 } = {}) {
  // ── Setup ───────────────────────────────────────────────────────────────────
  const cIndex = new Map();
  const cands  = targets.map((id, i) => {
    cIndex.set(id, i);
    return { id, approval: 0, score: 0, elected: false, backed: 0, edges: [] };   // edges: [voterIdx, edgeIdx]
  });

  const vs = [];
  for (const v of voters) {
    if (!(v.stake > 0)) continue;
    const edges = [];
    const seen  = new Set();
    for (const t of v.targets) {
      const ci = cIndex.get(t);
      if (ci === undefined || seen.has(ci)) continue;   // target not a candidate / duplicate
      seen.add(ci);
      edges.push({ c: ci, load: 0, weight: 0 });
    }
    if (edges.length === 0) continue;
    const vi = vs.length;
    vs.push({ id: v.id, budget: v.stake, load: 0, edges, nominated: v.targets.length });
    edges.forEach((e, ei) => {
      cands[e.c].approval += v.stake;
      cands[e.c].edges.push([vi, ei]);
    });
  }

  // ── Sequential Phragmén ─────────────────────────────────────────────────────
  // score(c) = (1 + Σ_{n→c} budget_n · load_n) / approval(c); lowest score wins.
  const elected = [];
  const rounds  = Math.min(toElect, cands.length);
  for (let round = 0; round < rounds; round++) {
    for (const c of cands) if (!c.elected && c.approval > 0) c.score = 1 / c.approval;
    for (const v of vs) {
      if (v.load === 0) continue;
      const x = v.budget * v.load;
      for (const e of v.edges) {
        const c = cands[e.c];
        if (!c.elected && c.approval > 0) c.score += x / c.approval;
      }
    }
    let best = null;
    for (const c of cands) {
      if (c.elected || c.approval <= 0) continue;
      if (best === null || c.score < best.score) best = c;
    }
    if (best === null) break;

    best.elected = true;
    elected.push(best);
    for (const [vi, ei] of best.edges) {
      const v = vs[vi];
      v.edges[ei].load = best.score - v.load;
      v.load = best.score;
    }
  }

  // Distribute each voter's budget across elected targets by edge load
  for (const v of vs) {
    for (const e of v.edges) {
      if (!cands[e.c].elected || v.load === 0) { e.weight = 0; continue; }
      e.weight = v.budget * e.load / v.load;
      cands[e.c].backed += e.weight;
    }
  }

  // ── Balancing ───────────────────────────────────────────────────────────────
  for (let iter = 0; iter < balancingIterations; iter++) {
    let maxDiff = 0;
    for (const v of vs) maxDiff = Math.max(maxDiff, balanceVoter(v, cands, tolerance));
    if (maxDiff <= tolerance) break;
  }

  const winners = elected
    .map(c => ({ id: c.id, support: c.backed }))
    .sort((a, b) => b.support - a.support);

  return {
    winners,
    approval: (id) => { const i = cIndex.get(id); return i === undefined ? 0 : cands[i].approval; },
    /** Voters backing a candidate with the stake share they give it. */
    backers: (id) => {
      const i = cIndex.get(id);
      if (i === undefined) return [];
      return cands[i].edges
        // targets = nominations that are current candidates; nominated = all nominations
        .map(([vi, ei]) => ({ voter: vs[vi].id, budget: vs[vi].budget, targets: vs[vi].edges.length, nominated: vs[vi].nominated, weight: vs[vi].edges[ei].weight }))
        .filter(b => b.weight > 0 || !cands[i].elected);
    },
  };
}

/** One voter's balancing step (sp-npos-elections balance_voter). Returns the imbalance seen. */
function balanceVoter(v, cands, tolerance) {
  const edges = v.edges.filter(e => cands[e.c].elected);
  if (edges.length === 0) return 0;

  const stakeUsed = edges.reduce((s, e) => s + e.weight, 0);
  const backing   = edges.filter(e => e.weight > 0).map(e => cands[e.c].backed);
  let difference;
  if (backing.length > 0) {
    const max = Math.max(...backing);
    const min = Math.min(...edges.map(e => cands[e.c].backed));
    difference = (max - min) + Math.max(0, v.budget - stakeUsed);
    if (difference < tolerance) return difference;
  } else {
    difference = v.budget;
  }

  // Take the voter's stake out, then water-fill the least backed targets
  for (const e of edges) { cands[e.c].backed -= e.weight; e.weight = 0; }
  edges.sort((a, b) => cands[a.c].backed - cands[b.c].backed);

  let cumulative = 0;
  let lastIndex  = edges.length - 1;
  for (let i = 0; i < edges.length; i++) {
    const backed = cands[edges[i].c].backed;
    if (backed * i - cumulative > v.budget) { lastIndex = i - 1; break; }
    cumulative += backed;
  }
  const lastStake   = cands[edges[lastIndex].c].backed;
  const waysToSplit = lastIndex + 1;
  const excess      = v.budget + cumulative - lastStake * waysToSplit;
  for (let i = 0; i < waysToSplit; i++) {
    const e = edges[i];
    e.weight = excess / waysToSplit + lastStake - cands[e.c].backed;
    cands[e.c].backed += e.weight;
  }
  return difference;
}

module.exports = { seqPhragmen };
