import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

process.env.JOB_DB_PATH = '.test-jobs.sqlite';
const { getJob, insertJob, writeJobResult, orderProviders } = await import('../src/jobStore.mjs');

test.after(() => {
  for (const f of ['.test-jobs.sqlite', '.test-jobs.sqlite-journal']) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
});

test('jobStore: round-trip matches the section-03 schema fields', () => {
  insertJob({
    id: 'job-1',
    hotel_name: 'Sofitel Mumbai BKC',
    check_in: '2026-10-15',
    check_out: '2026-10-18',
    room_type: 'Luxury King Room',
    guests: 2,
    providers: [{ name: 'Trip.com', homepage: 'https://us.trip.com', pricePerNight: 207 }],
    selected_provider: 'Trip.com',
  });

  const job = getJob('job-1');
  assert.equal(job.hotel_name, 'Sofitel Mumbai BKC');
  assert.equal(job.check_in, '2026-10-15');
  assert.equal(job.guests, 2);
  assert.equal(job.selected_provider, 'Trip.com');
  assert.equal(job.status, 'pending');
  assert.deepEqual(job.providers, [{ name: 'Trip.com', homepage: 'https://us.trip.com', pricePerNight: 207 }]);
});

test('jobStore: writeJobResult updates status/error/proof_url on the same row - success case', () => {
  insertJob({ id: 'job-2', hotel_name: 'Hotel McCoy', check_in: '2026-11-02', check_out: '2026-11-04', guests: 2, providers: [] });
  writeJobResult('job-2', { status: 'reached_payment', proof_url: 'proof/hotel_mccoy_123.png' });

  const job = getJob('job-2');
  assert.equal(job.status, 'reached_payment');
  assert.equal(job.proof_url, 'proof/hotel_mccoy_123.png');
  assert.equal(job.error, null);
});

test('jobStore: writeJobResult - failure case records the reason, not silently', () => {
  insertJob({ id: 'job-3', hotel_name: 'Unknown Hotel', check_in: '2026-12-01', check_out: '2026-12-02', guests: 1, providers: [] });
  writeJobResult('job-3', { status: 'needs_review', error: 'all providers exhausted' });

  const job = getJob('job-3');
  assert.equal(job.status, 'needs_review');
  assert.equal(job.error, 'all providers exhausted');
});

// REGRESSION (colleague review, 2026-09): `selected_provider` round-tripped through storage correctly (see
// above) but worker.mjs never actually read it - a job whose selected provider differed from providers[0]
// would have silently started from the wrong one. orderProviders() is what worker.mjs now calls before
// handing the list to bookHotel().
test('orderProviders: puts the job\'s selected_provider first even when it is NOT providers[0]', () => {
  const providers = [
    { name: 'Vio.com', pricePerNight: 218 },
    { name: 'Traveluro', pricePerNight: 219 },
    { name: 'Agoda', pricePerNight: 230 },
  ];
  assert.deepEqual(orderProviders(providers, 'Agoda'), [
    { name: 'Agoda', pricePerNight: 230 },
    { name: 'Vio.com', pricePerNight: 218 },
    { name: 'Traveluro', pricePerNight: 219 },
  ]);
});

test('orderProviders: already-first selected_provider is a no-op', () => {
  const providers = [{ name: 'Vio.com', pricePerNight: 218 }, { name: 'Traveluro', pricePerNight: 219 }];
  assert.deepEqual(orderProviders(providers, 'Vio.com'), providers);
});

test('orderProviders: missing/unmatched selected_provider falls back to the given order unchanged, does not throw', () => {
  const providers = [{ name: 'Vio.com', pricePerNight: 218 }];
  assert.deepEqual(orderProviders(providers, null), providers);
  assert.deepEqual(orderProviders(providers, 'Sold Out Provider'), providers);
  assert.deepEqual(orderProviders(undefined, 'Vio.com'), []);
});
