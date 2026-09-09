import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { looksLikePayment, hasPaymentInputFields, requiredFieldsFilled, isRelevantFrame, hasInvalidField, matchesRequestedHotel } from '../src/verify.mjs';
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

// GUARDRAIL (colleague review, 2026-09): every check above only ever asks "is this A real, validly-filled
// payment page" - never "is this THE payment page for the hotel we were actually asked to book". Manually
// auditing every live proof screenshot on file (Agoda/Traveloka/Mews) found the hotel name was in fact
// correct in all of them - but that was never enforced by the code, only true by luck. matchesRequestedHotel
// closes that gap.
test('matchesRequestedHotel: positive - requested hotel\'s name appears verbatim in the flow text', () => {
  assert.equal(matchesRequestedHotel('Sofitel Mumbai BKC\nThu, Oct 15 - Sun, Oct 18', 'Sofitel Mumbai BKC'), true);
});

test('matchesRequestedHotel: negative - a completely different, unrelated hotel', () => {
  assert.equal(matchesRequestedHotel('Four Points by Sheraton Bali, Seminyak\nCheck-in Thu 15 Oct', 'Sofitel Mumbai BKC'), false);
});

test('matchesRequestedHotel: positive - tolerates ONE dropped/abbreviated word (a location suffix)', () => {
  // Real site behavior, live-verified: a property's own displayed name can drop a trailing qualifier
  // ("BKC") without it being a different hotel at all.
  assert.equal(matchesRequestedHotel('Welcome to Sofitel Mumbai - Payment details', 'Sofitel Mumbai BKC'), true);
});

test('matchesRequestedHotel: negative - two different properties must not pass on a shared generic word alone', () => {
  // "Hotel" and "Mumbai" alone are not enough to conflate two different, actual properties.
  assert.equal(matchesRequestedHotel('Grand Mumbai Hotel - Payment details', 'Sofitel Mumbai BKC'), false);
});

test('matchesRequestedHotel: degenerate/empty requested name never blocks (nothing distinctive to check)', () => {
  assert.equal(matchesRequestedHotel('Some Payment Page', ''), true);
  assert.equal(matchesRequestedHotel('Some Payment Page', null), true);
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

test('REGRESSION (found live 2026-09 on Mari Jean Hotel/Mews): an about:blank frame defaults to relevant, since Playwright reports a same-page injected-content widget this way forever, with no real URL to check', () => {
  const main = 'https://app.mews.com/distributor/a4197217-ab80-4ad5-b585-b0b90089db3d';
  assert.equal(isRelevantFrame('about:blank', main), true);
  assert.equal(isRelevantFrame('', main), true);
});

test('REGRESSION (found live 2026-09 on Mari Jean Hotel/Mews): an UNLISTED payment processor is still recognized via its own URL, not just the fixed host list', () => {
  // Datatrans isn't in KNOWN_PAYMENT_PROCESSOR_HOSTS at all - this must pass on the URL-content heuristic
  // alone. Live, this false negative meant the real payment page was never once recognized programmatically
  // across every attempt, only ever self-reported by the model - the mirror image of the Agoda false
  // positive this module exists to fix.
  const main = 'https://app.mews.com/distributor/a4197217-ab80-4ad5-b585-b0b90089db3d';
  const datatransUrl = 'https://pay.datatrans.com/upp/payment/SecureFields/paymentField?mode=TOKENIZE&fieldName=cardNumber';
  assert.equal(isRelevantFrame(datatransUrl, main), true, 'unlisted processor recognized by URL content, not host');
  // Sanity check: an ad network URL never coincidentally matches the same heuristic.
  assert.equal(isRelevantFrame('https://insight.adsrvr.org/track/cei?advertiser_id=x', main), false);
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

test('REGRESSION (found live 2026-09 on Mari Jean Hotel/Mews): a required guest field the agent never even attempted - not just one it tried and failed - must block success', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/guest`);

    // Only "First name" was ever ATTEMPTED - Last name/Email/Phone are absent from the trace entirely
    // (the model never tried them at all), not merely present-but-empty. The old check had nothing to
    // re-verify for a field it was never told about, and passed vacuously.
    const trace = [{ action: 'fill', role: 'textbox', name: 'First name', field: 'firstName' }];
    await page.getByRole('textbox', { name: 'First name' }).fill('Max');

    const result = await requiredFieldsFilled(page, trace);
    assert.equal(result.ok, false, 'Last name/Email/Phone are visibly empty and must block success even though nothing in the trace mentions them');

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

    // fill it, but the fixture's OTHER two guest fields (Last name, Phone) are still empty and were never
    // tracked in this trace at all - must still fail, on the untracked-empty-field check now.
    await page.getByRole('textbox', { name: 'Email' }).fill('test@example.com');
    result = await requiredFieldsFilled(page, trace);
    assert.equal(result.ok, false);

    // fill everything visible on the page -> now it genuinely passes
    await page.getByRole('textbox', { name: 'Last name' }).fill('Mustermann');
    await page.getByRole('textbox', { name: 'Phone' }).fill('1700000000');
    result = await requiredFieldsFilled(page, trace);
    assert.equal(result.ok, true);

    await browser.close();
  } finally {
    server.close();
  }
});

test('REGRESSION (found live 2026-09 on Mari Jean Hotel/Mews): a field that is filled but fails the site\'s own validation (aria-invalid="true") must block success, not just an empty field', async () => {
  const { server, baseUrl } = await startFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/guest`);

    await page.getByRole('textbox', { name: 'First name' }).fill('Max');
    await page.getByRole('textbox', { name: 'Last name' }).fill('Mustermann');
    await page.getByRole('textbox', { name: 'Email' }).fill('test@example.com');
    // Filled, but marked invalid by the site's own (simulated) validation - not empty, just rejected.
    const phone = page.getByRole('textbox', { name: 'Phone' });
    await phone.fill('not-a-real-phone-number');
    await phone.evaluate((el) => el.setAttribute('aria-invalid', 'true'));

    assert.equal(await hasInvalidField(page), true);
    const trace = [
      { action: 'fill', role: 'textbox', name: 'First name', field: 'firstName' },
      { action: 'fill', role: 'textbox', name: 'Last name', field: 'lastName' },
      { action: 'fill', role: 'textbox', name: 'Email', field: 'email' },
      { action: 'fill', role: 'textbox', name: 'Phone', field: 'phone' },
    ];
    let result = await requiredFieldsFilled(page, trace);
    assert.equal(result.ok, false, 'a filled-but-invalid field must block success');

    // Clear the error the way a real fix would - correct the value and the validation state.
    await phone.fill('1700000000');
    await phone.evaluate((el) => el.setAttribute('aria-invalid', 'false'));
    result = await requiredFieldsFilled(page, trace);
    assert.equal(result.ok, true);

    await browser.close();
  } finally {
    server.close();
  }
});
