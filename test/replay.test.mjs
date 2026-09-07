import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { replay } from '../src/replay.mjs';
import { startFixture } from './fixture/server.mjs';

const HAPPY_PATH_RECORDING = [
  { action: 'click', role: 'button', name: 'Search' },
  { action: 'click', role: 'button', name: 'Reserve' },
  { action: 'fill', role: 'textbox', name: 'First name', field: 'firstName' },
  { action: 'fill', role: 'textbox', name: 'Last name', field: 'lastName' },
  { action: 'fill', role: 'textbox', name: 'Email', field: 'email' },
  { action: 'fill', role: 'textbox', name: 'Phone', field: 'phone' },
  { action: 'click', role: 'button', name: 'Continue' },
];

test('replay: full recording succeeds end to end on the fixture', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl);

    const params = { firstName: 'Max', lastName: 'Mustermann', email: 'test@example.com', phone: '+49 170 0000000' };
    const result = await replay(page, HAPPY_PATH_RECORDING, params);

    assert.equal(result.broken, false);
    assert.match(page.url(), /\/payment$/);

    const emailValue = await page.getByRole('textbox', { name: 'Email' }).inputValue().catch(() => null);
    // email field lives on /guest, which we've navigated past by now - just confirm we got to payment cleanly
    assert.ok(page.url().endsWith('/payment'));

    await browser.close();
  } finally {
    server.close();
  }
});

test('replay: reports the exact broken step index when an element is gone (drift)', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // /guest-broken has no Email field - simulates the site dropping that field between recording and replay
    await page.goto(`${baseUrl}/guest-broken`);

    const brokenRecording = [
      { action: 'fill', role: 'textbox', name: 'First name', field: 'firstName' },
      { action: 'fill', role: 'textbox', name: 'Last name', field: 'lastName' },
      { action: 'fill', role: 'textbox', name: 'Email', field: 'email' }, // step index 2 - does not exist here
      { action: 'click', role: 'button', name: 'Continue' },
    ];

    const params = { firstName: 'Max', lastName: 'Mustermann', email: 'test@example.com' };
    const result = await replay(page, brokenRecording, params);

    assert.equal(result.broken, true);
    assert.equal(result.brokenAtStep, 2);
    // the page object handed back is the SAME live page, still on /guest-broken, mid-flow, not reset
    assert.ok(result.page.url().includes('/guest-broken'));

    await browser.close();
  } finally {
    server.close();
  }
});

test('replay: a field-tagged date CLICK replays fine when the requested date matches what was recorded', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/calendar`);

    const recording = [
      { action: 'click', role: 'button', name: 'Oct 15 2026', field: 'checkIn', text: '2026-10-15' },
    ];
    const result = await replay(page, recording, { checkIn: '2026-10-15' });

    assert.equal(result.broken, false);
    await browser.close();
  } finally {
    server.close();
  }
});

test('REGRESSION (gap found 2026-09 auditing against the trial-task spec: a recording could never actually replay with different dates/room type): a field-tagged date CLICK is treated as broken - not blindly replayed against the stale date - when the requested date has changed', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/calendar`);

    // Recorded for Oct 15, but THIS run wants Nov 5 - a date this fixture page doesn't even have a button
    // for. Must be recognized as broken from the field/text mismatch alone, not from a failed click attempt.
    const recording = [
      { action: 'click', role: 'button', name: 'Oct 15 2026', field: 'checkIn', text: '2026-10-15' },
    ];
    const result = await replay(page, recording, { checkIn: '2026-11-05' });

    assert.equal(result.broken, true);
    assert.equal(result.brokenAtStep, 0);
    await browser.close();
  } finally {
    server.close();
  }
});

test('replay: a field-tagged roomType CLICK is NOT forced to break when no room-type preference was requested', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl);

    const recording = [
      { action: 'click', role: 'button', name: 'Search', field: null },
      { action: 'click', role: 'button', name: 'Reserve', field: 'roomType', text: 'Luxury King Room' },
    ];
    // no roomType requested at all - "a preference, not a hard filter" - so the recorded choice stands
    const result = await replay(page, recording, {});

    assert.equal(result.broken, false);
    assert.match(page.url(), /\/guest$/);
    await browser.close();
  } finally {
    server.close();
  }
});

test('replay: a pixel-fallback step (no role/name) is treated as broken, not blindly replayed', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl);

    const recording = [{ action: 'click', x: 999, y: 999 }]; // no role/name recorded
    const result = await replay(page, recording, {});

    assert.equal(result.broken, true);
    assert.equal(result.brokenAtStep, 0);

    await browser.close();
  } finally {
    server.close();
  }
});
