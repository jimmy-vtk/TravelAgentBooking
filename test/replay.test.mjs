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
