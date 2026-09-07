import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync } from 'node:fs';

process.env.COST_LOG_PATH = '.test-cost-log.jsonl';
const { logAttempt, summarize } = await import('../src/costLog.mjs');

test.after(() => {
  if (existsSync('.test-cost-log.jsonl')) rmSync('.test-cost-log.jsonl', { force: true });
});

test('costLog: logAttempt appends one JSON line per attempt with a timestamp', () => {
  logAttempt({ hotelName: 'HARRIS Hotel Seminyak', provider: 'Tiket.com', status: 'success', success: true, why: 'payment', tookMs: 1000, costUsd: 0.123456789, apiCalls: 5, inputTokens: 1000, outputTokens: 200 });

  const lines = readFileSync('.test-cost-log.jsonl', 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.hotelName, 'HARRIS Hotel Seminyak');
  assert.equal(entry.success, true);
  assert.ok(entry.ts); // real timestamp present
  assert.equal(entry.costUsd, 0.123457); // rounded to 6 decimal places, not left as a long float
});

test('costLog: summarize totals cost/calls across attempts and can filter by hotel/provider', () => {
  logAttempt({ hotelName: 'HARRIS Hotel Seminyak', provider: 'Tiket.com', status: 'stuck', success: false, tookMs: 500, costUsd: 0.5, apiCalls: 10 });
  logAttempt({ hotelName: 'Sofitel Mumbai BKC', provider: 'Trip.com', status: 'success', success: true, tookMs: 700, costUsd: 0.25, apiCalls: 8 });

  const all = summarize();
  assert.equal(all.attempts, 3);
  assert.equal(all.successes, 2); // test 1's Tiket.com success + this test's Trip.com success
  assert.ok(Math.abs(all.totalCostUsd - (0.123457 + 0.5 + 0.25)) < 1e-6);

  const tiketOnly = summarize({ provider: 'Tiket.com' });
  assert.equal(tiketOnly.attempts, 2);
  assert.equal(tiketOnly.successes, 1);
});
