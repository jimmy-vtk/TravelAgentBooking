// A persistent, append-only record of every Discover/replay attempt's real API cost - one JSON line per
// attempt. Each run already computes its own tookMs/costUsd/apiCalls (see discover.mjs), but that number
// only ever existed in that one run's terminal output; answering "what have we spent so far" meant
// manually scrolling back and re-summing printed results by hand. This gives a single file to sum instead,
// and doubles as the "cost/runtime logging" the client explicitly asked for (2026-09 feedback) - a
// reviewable audit trail per attempt, not just a final total.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LOG_PATH = process.env.COST_LOG_PATH || 'cost-log.jsonl';

export function logAttempt({ hotelName, provider, status, success, why, tookMs, costUsd, apiCalls, inputTokens, outputTokens, replayed, resumedFromStep }) {
  const dir = dirname(LOG_PATH);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    hotelName,
    provider,
    status,
    success: !!success,
    why: why ?? null,
    tookMs: tookMs ?? 0,
    costUsd: Number((costUsd ?? 0).toFixed(6)),
    apiCalls: apiCalls ?? 0,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    replayed: !!replayed,
    resumedFromStep: resumedFromStep ?? null,
  };
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
  return entry;
}

// Running totals across every logged attempt (optionally filtered), for quick "what have we spent so far"
// answers without hand-summing terminal scrollback.
export function summarize({ hotelName, provider } = {}) {
  if (!existsSync(LOG_PATH)) return { attempts: 0, successes: 0, totalCostUsd: 0, totalApiCalls: 0, totalTookMs: 0 };
  const lines = readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).filter((e) => (!hotelName || e.hotelName === hotelName) && (!provider || e.provider === provider));

  return entries.reduce((acc, e) => ({
    attempts: acc.attempts + 1,
    successes: acc.successes + (e.success ? 1 : 0),
    totalCostUsd: Number((acc.totalCostUsd + (e.costUsd || 0)).toFixed(6)),
    totalApiCalls: acc.totalApiCalls + (e.apiCalls || 0),
    totalTookMs: acc.totalTookMs + (e.tookMs || 0),
  }), { attempts: 0, successes: 0, totalCostUsd: 0, totalApiCalls: 0, totalTookMs: 0 });
}
