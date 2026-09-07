import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { looksLikePayment, hasPaymentInputFields, requiredFieldsFilled, isRelevantFrame } from '../src/verify.mjs';
import { startFixture } from './fixture/server.mjs';

test('looksLikePayment: positive - real payment wording + price', () => {
  assert.equal(looksLikePayment('Enter your card number and CVV. Total: 200.00 EUR'), true);
});

test('looksLikePayment: negative - results page with a price but no payment wording', () => {
  assert.equal(looksLikePayment('Fixture Hotel - 200 EUR/night. Click Reserve to continue.'), false);
});

test('looksLikePayment: negative - payment wording with no price nearby', () => {
  assert.equal(looksLikePayment('Learn more about our payment security policy.'), false);
});

test('looksLikePayment: negative - unrelated page with a stray currency symbol', () => {
  assert.equal(looksLikePayment('This café serves €3 coffee. About us. Contact.'), false);
});

test('REGRESSION (found live on Halalbooking, 2026-09): a page whose own breadcrumb mentions "Payment" as an upcoming step must NOT be flagged - looksLikePayment(text) alone is true here, but there is no real payment form', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/guest`);

    const text = await page.evaluate(() => document.body.innerText);
    assert.equal(looksLikePayment(text), true, 'sanity check: the text-only signal is a false positive here, as expected');
    assert.equal(await hasPaymentInputFields(page), false, 'the DOM-based check must reject it - no card fields are actually present');

    await browser.close();
  } finally {
    server.close();
  }
});

test('isRelevantFrame: same site and known payment processors pass, unrelated third parties do not', () => {
  const main = 'https://www.agoda.com/book/payment/';
  assert.equal(isRelevantFrame('https://www.agoda.com/search', main), true, 'same registrable domain');
  assert.equal(isRelevantFrame('https://secure.agoda.com/payment/index-v4.html', main), true, 'subdomain of same site - the real Agoda card iframe');
  assert.equal(isRelevantFrame('https://js.stripe.com/v3/', main), true, 'known payment processor');
  assert.equal(isRelevantFrame('https://cm.g.doubleclick.net/partnerpixels', main), false, 'unrelated ad network');
  assert.equal(isRelevantFrame('https://www.google.com/recaptcha/api2/aframe', main), false, 'unrelated captcha widget');
});

test('REGRESSION (found live on Agoda, 2026-09): an unrelated third-party ad iframe must not trip payment detection on its own - live, this fired on the SEARCH RESULTS page, before the booking flow had even started, and caused an auto-saved recording that stopped 8 steps too early', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/results-with-ad-iframe`);
    await page.waitForTimeout(200); // let the iframe finish loading

    // Sanity check: the ad iframe alone genuinely does satisfy both signals, unscoped - this proves the
    // fixture reproduces the bug rather than accidentally testing nothing.
    const adFrame = page.frames().find((f) => f.url().includes('/ad'));
    const adText = await adFrame.evaluate(() => document.body.innerText);
    assert.equal(looksLikePayment(adText), true, 'sanity check: the ad copy alone is a false-positive trigger, as expected');

    assert.equal(await hasPaymentInputFields(page), false, 'the ad iframe is a different site and must be excluded, even though it has a card-shaped input');
    await browser.close();
  } finally {
    server.close();
  }
});

test('hasPaymentInputFields: true on the real payment page', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/payment`);
    assert.equal(await hasPaymentInputFields(page), true);
    await browser.close();
  } finally {
    server.close();
  }
});

test('requiredFieldsFilled: an empty trace (nothing ever filled) is not success, not vacuously true', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/payment`);
    const result = await requiredFieldsFilled(page, []);
    assert.equal(result.ok, false);
    await browser.close();
  } finally {
    server.close();
  }
});

test('requiredFieldsFilled: fails when a tracked field is empty, passes once filled', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/guest`);

    const trace = [
      { action: 'fill', role: 'textbox', name: 'First name', field: 'firstName' },
      { action: 'fill', role: 'textbox', name: 'Email', field: 'email' },
    ];

    // email left empty -> must fail
    await page.getByRole('textbox', { name: 'First name' }).fill('Max');
    let result = await requiredFieldsFilled(page, trace);
    assert.equal(result.ok, false);
    assert.equal(result.missingField, 'email');

    // fill it -> must pass
    await page.getByRole('textbox', { name: 'Email' }).fill('test@example.com');
    result = await requiredFieldsFilled(page, trace);
    assert.equal(result.ok, true);

    await browser.close();
  } finally {
    server.close();
  }
});
