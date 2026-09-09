// REGRESSION (colleague review, 2026-09): the provider-fallback loop in bookHotel.mjs - try cheapest first,
// skip a genuine failure, succeed on the next one, name the right provider in the result - was previously
// "correct by inspection" only. No fixture test isolated it, and no live run ever actually exercised it:
// every real run's own providers.json only ever contained a single provider, so the "try the next one"
// branch had never once fired, in any test or any live run, despite being a literal, named evaluation
// criterion ("failures automatically trigger the next-cheapest provider... instead of giving up on the job
// right away"). This closes that gap with the real, exported bookHotel() function - not a reimplementation -
// using the deps injection seam added to bookHotel.mjs for exactly this purpose. No real browser, no model
// call, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

process.env.RECORDINGS_DIR = '.test-bookhotel-recordings';
process.env.COST_LOG_PATH = '.test-bookhotel-cost-log.jsonl';
const { bookHotel } = await import('../src/bookHotel.mjs');

test.after(() => {
  if (existsSync('.test-bookhotel-recordings')) rmSync('.test-bookhotel-recordings', { recursive: true, force: true });
  if (existsSync('.test-bookhotel-cost-log.jsonl')) rmSync('.test-bookhotel-cost-log.jsonl', { force: true });
});

function fakeContext() {
  return {
    newPage: async () => ({ close: async () => {}, screenshot: async () => {} }),
    close: async () => {},
  };
}

test('bookHotel: a genuinely failing first provider is skipped, the next-cheapest succeeds, and the result names the one that ACTUALLY succeeded - not the first/cheapest tried, and never touches a third provider once one succeeds', async () => {
  const providers = [
    { name: 'Broken Provider', homepage: 'http://broken.invalid', pricePerNight: 100 },
    { name: 'Working Provider', homepage: 'http://working.invalid', pricePerNight: 150 },
    { name: 'Should Never Be Attempted', homepage: 'http://never.invalid', pricePerNight: 200 },
  ];
  let call = 0;
  const deps = {
    launchContext: async () => fakeContext(),
    warmSession: async () => {}, // homepages above are fake - no real navigation to attempt
    discover: async () => {
      call++;
      if (call === 1) return { success: false, why: 'stuck', reason: 'fixture: forced failure on first provider', trace: [] };
      return { success: true, why: 'payment', trace: [{ action: 'fill', role: 'textbox', name: 'Email', field: 'email', text: 'test@example.com' }], tookMs: 5, costUsd: 0.01, apiCalls: 1 };
    },
  };

  const result = await bookHotel({
    hotelName: 'Fixture Test Hotel', checkIn: '2026-12-01', checkOut: '2026-12-03', roomType: null, guests: 2,
    providers, deps,
  });

  assert.equal(call, 2, 'both the failing AND the succeeding provider must actually be attempted - not more, not fewer');
  assert.equal(result.status, 'reached_payment');
  assert.equal(result.provider, 'Working Provider', 'must name the provider that ACTUALLY succeeded, not the first/cheapest one tried');
  assert.equal(result.attempts.length, 2, 'the third provider must never be attempted once an earlier one succeeds');
  assert.equal(result.attempts[0].provider, 'Broken Provider');
  assert.equal(result.attempts[0].success, false);
  assert.equal(result.attempts[1].provider, 'Working Provider');
  assert.equal(result.attempts[1].success, true);

  // GUARDRAIL (colleague review, 2026-09; §07: "one screenshot of the state reached per attempt") - the
  // FAILED attempt must have its own proof too, not just the winning one.
  assert.ok(result.attempts[0].proof, 'the failed attempt must have its own screenshot, not just the winning one');
  assert.ok(result.attempts[0].proof.includes('failed'));
  assert.ok(result.attempts[1].proof, 'the succeeding attempt must also have its own screenshot');
  assert.ok(result.attempts[1].proof.includes('success'));
  assert.equal(result.proof, result.attempts[1].proof, 'the top-level proof must be the WINNING attempt\'s screenshot');
});

test('bookHotel: every provider failing is reported as needs_review with every attempt recorded, not silently swallowed', async () => {
  const providers = [
    { name: 'Broken A', homepage: 'http://broken-a.invalid', pricePerNight: 100 },
    { name: 'Broken B', homepage: 'http://broken-b.invalid', pricePerNight: 150 },
  ];
  const deps = {
    launchContext: async () => fakeContext(),
    warmSession: async () => {},
    discover: async () => ({ success: false, why: 'stuck', reason: 'fixture: forced failure', trace: [] }),
  };

  const result = await bookHotel({
    hotelName: 'Fixture Test Hotel', checkIn: '2026-12-01', checkOut: '2026-12-03', roomType: null, guests: 2,
    providers, deps,
  });

  assert.equal(result.status, 'needs_review');
  assert.equal(result.attempts.length, 2);
  assert.ok(result.attempts.every((a) => a.success === false));
  assert.deepEqual(result.attempts.map((a) => a.provider), ['Broken A', 'Broken B']);
});
