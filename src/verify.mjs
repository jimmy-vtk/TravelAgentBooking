// Success verification. Two checks, both required:
//  1. looksLikePayment(text)     - regex/text-match only, no OCR/NLP (per the trial task's own suggestion)
//  2. requiredFieldsFilled(...)  - reads the DOM's actual field values, not just page text. Reaching a
//     payment-looking page with an empty required field is NOT success (client feedback, 2026-09).

const PAYMENT_WORDS = /payment|credit card|card number|cvv|cvc|billing address|zahlung|kreditkarte|karte\b|carte de cr[ée]dit|expiry|expiration date/i;
const PRICE_WORDS = /[€$£]\s?\d|\d[.,]\d{2}\s?(eur|usd|gbp|€|\$|£)|total\b|gesamtbetrag|betrag\b/i;

export function looksLikePayment(text) {
  const t = String(text || '');
  return PAYMENT_WORDS.test(t) && PRICE_WORDS.test(t);
}

// A much stronger signal than page text: does the DOM actually contain a card-shaped INPUT field right
// now? A step breadcrumb/nav label that merely *mentions* "payment"/"Zahlung" as an upcoming step (proven
// live, 2026-09: Halalbooking's own step indicator did exactly this on the guest-details page) can trip
// looksLikePayment() without a real payment form anywhere on screen - this cannot, since it requires an
// actual <input> whose accessible name matches a card-field pattern to exist and be visible.
const CARD_FIELD_WORDS = /card number|kartennummer|credit card|kreditkarte|cvv|cvc|carte de cr[ée]dit|num[ée]ro de carte|expiry|expiration/i;

// Real payment processors this check must still catch even though their iframe is cross-origin from the
// booking site itself (PCI compliance requires the card form to live on the processor's own origin, not
// the merchant's).
const KNOWN_PAYMENT_PROCESSOR_HOSTS = /(^|\.)(stripe\.com|adyen\.com|braintreegateway\.com|braintree-api\.com|checkout\.com|worldpay\.com|paypal\.com|paypalobjects\.com|klarna\.com|squareup\.com|square\.com|authorize\.net|cybersource\.com|payu\.com|razorpay\.com|2checkout\.com|verifone\.com|ingenico\.com|globalpayments\.com|cardinalcommerce\.com)$/i;

function registrableDomain(hostname) {
  const parts = hostname.split('.');
  return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

// Live-verified 2026-09 on Agoda: a completely unrelated third-party ad/tracking iframe on the SEARCH
// RESULTS page (the page carries many - doubleclick, criteo, recaptcha, etc.) contained a hidden field
// whose label happened to match CARD_FIELD_WORDS, firing a false "payment page reached" only a few steps
// into a fresh search. Scope the scan to frames that are actually part of the booking flow: same site as
// the main page, or a known payment-processor domain (see above, and the cross-origin-iframe comment below
// for why those must stay included). Everything else - ad networks, captcha widgets, unrelated trackers -
// is excluded regardless of its content.
export function isRelevantFrame(frameUrl, mainUrl) {
  try {
    const frameHost = new URL(frameUrl).hostname;
    const mainHost = new URL(mainUrl).hostname;
    if (registrableDomain(frameHost) === registrableDomain(mainHost)) return true;
    return KNOWN_PAYMENT_PROCESSOR_HOSTS.test(frameHost);
  } catch {
    return true; // unparseable (about:blank, data:, etc.) - can't prove it's irrelevant, so don't skip it
  }
}

// Card entry is almost always embedded in a cross-origin <iframe> for PCI compliance (Stripe, Adyen,
// Braintree, etc.) - live-verified 2026-09 on Agoda: the model visually recognized a real, on-screen card
// form and correctly stopped before touching it, but this check (main frame only, at the time) missed it
// entirely and the run was misreported as a failure. Playwright's page.frames() reaches into iframes
// regardless of origin (it drives the browser via CDP, not in-page JS, so same-origin policy doesn't apply)
// - check every RELEVANT frame (see isRelevantFrame), not just the top-level document.
export async function hasPaymentInputFields(page) {
  const mainUrl = page.url();
  const checkFrame = async (frame) => {
    try {
      return await frame.evaluate((pattern) => {
        const re = new RegExp(pattern, 'i');
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const inputs = [...document.querySelectorAll('input, [role=textbox]')].filter(visible);
        return inputs.some((el) => {
          const label = [
            el.getAttribute('aria-label') || '',
            el.getAttribute('placeholder') || '',
            el.name || '',
            el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText || '') : '',
          ].join(' ');
          return re.test(label);
        });
      }, CARD_FIELD_WORDS.source);
    } catch {
      return false; // detached or otherwise unreachable frame - not a match, not a hard error
    }
  };
  for (const frame of page.frames()) {
    if (!isRelevantFrame(frame.url(), mainUrl)) continue;
    if (await checkFrame(frame)) return true;
  }
  return false;
}

// Re-reads every `fill` step in the trace that was tagged with a `field` (i.e. every field the agent
// itself considers a required, goal-relevant input - hotel name, dates, guest name/email/phone, etc.)
// and confirms the live DOM element still holds a non-empty value.
//
// A field's locator not resolving at all on the CURRENT page is not the same as it being empty - a
// multi-page checkout (guest-details page, then a separate payment page) means fields filled earlier
// genuinely don't exist in the DOM once we've navigated past that page, and the prior page's own client
// validation already gated letting us advance - live-verified 2026-09 on Agoda: every guest field was
// correctly filled, but the payment page's own DOM no longer has a "First name" textbox to re-check, so
// this used to hard-fail the whole run. Only a field that's genuinely PRESENT but empty is a real failure.
//
// A step with no `role`/`name` locator (a raw pixel-coordinate fallback - see discover.mjs) can't be
// re-resolved to double-check its live value, but it's still real evidence the agent typed something at
// the time: live-verified 2026-09 on Agoda, every guest field went through this exact fallback path (an
// interstitial popup a step earlier apparently disrupted ref-matching) and all four were correctly filled,
// yet excluding them entirely left zero trackable fields, which tripped the vacuous-empty guard below and
// hard-failed a run that had, in fact, filled everything correctly. Trust a pixel-fallback fill that has a
// real non-empty `text` rather than discarding it; still reject one with empty/missing text.
export async function requiredFieldsFilled(page, trace) {
  const fillSteps = (trace || []).filter((s) => s.action === 'fill' && s.field);
  // Vacuously "all filled" over an empty set is not success - reaching what looks like payment without
  // ever having filled a single tracked field is exactly the bug this function exists to catch.
  if (fillSteps.length === 0) return { ok: false, missingField: null, reason: 'no fields were ever filled' };
  for (const step of fillSteps) {
    if (!step.role || !step.name) {
      if (!step.text || !step.text.trim()) return { ok: false, missingField: step.field };
      continue;
    }
    const loc = page.getByRole(step.role, { name: step.name, exact: false }).first();
    let count = 0;
    try {
      count = await loc.count();
    } catch {
      count = 0;
    }
    if (count === 0) continue; // belongs to a page we've since navigated past - nothing to re-check here
    try {
      const value = await loc.inputValue({ timeout: 2000 });
      if (process.env.DEBUG_PAYMENT_CHECK) {
        console.error(`[requiredFieldsFilled] field=${step.field} role=${step.role} name=${step.name} count=${count} value=${JSON.stringify(value)}`);
      }
      if (!value || !value.trim()) return { ok: false, missingField: step.field };
    } catch (e) {
      if (process.env.DEBUG_PAYMENT_CHECK) {
        console.error(`[requiredFieldsFilled] field=${step.field} role=${step.role} name=${step.name} count=${count} inputValue THREW: ${e.message}`);
      }
      return { ok: false, missingField: step.field };
    }
  }
  return { ok: true };
}
