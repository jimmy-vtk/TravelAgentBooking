// Success verification. Three checks, all required:
//  1. looksLikePayment(text)       - regex/text-match only, no OCR/NLP (per the trial task's own suggestion)
//  2. requiredFieldsFilled(...)    - reads the DOM's actual field values, not just page text. Reaching a
//     payment-looking page with an empty required field is NOT success (client feedback, 2026-09).
//  3. matchesRequestedHotel(...)   - every check above asks "is this A real payment page", never "is this
//     THE payment page for the hotel we were actually asked to book" - a genuinely reachable, validly-filled
//     checkout for the WRONG property would satisfy both checks above and still not be a correct booking.

const PAYMENT_WORDS = /payment|credit card|card number|cvv|cvc|billing address|zahlung|kreditkarte|karte\b|carte de cr[ée]dit|expiry|expiration date/i;
// REGRESSION (found live 2026-09 on Agoda, "The Westin Mumbai Garden City" - a genuinely different, never-
// before-seen hotel used specifically to prove the major-OTA path generalizes beyond the one Agoda hotel
// already proven): a live run reached a real, correct, fully-verified payment page - hasPaymentInputFields,
// requiredFieldsFilled, hasEmptyRequiredGuestField, hasInvalidField, and matchesRequestedHotel ALL correctly
// passed - and STILL wasn't recognized as success, because looksLikePayment's own PRICE_WORDS never matched
// at all. The price on screen was in Vietnamese Dong ("₫ 20,540,983"), not covered by the fixed EUR/USD/GBP/
// symbol list - a direct side effect of this project's own browser context hardcoding `timezoneId:
// 'Asia/Saigon'` (see bookHotel.mjs), which leads several real sites (Agoda included) to default their
// price DISPLAY currency to VND for this session, regardless of what hotel or provider is being booked.
// The earlier Sofitel/Agoda success never actually exercised this path correctly either - it happened to
// pass PRICE_WORDS on some other incidental match in the aggregated page text, not because VND pricing was
// ever actually handled - so this was a real, live gap hiding behind a lucky coincidence, not a new one.
const PRICE_WORDS = /[€$£₫]\s?\d|\d[.,]\d{2}\s?(eur|usd|gbp|vnd|€|\$|£|₫)|\d[\d.,]*\s?(vnd|₫)|total\b|gesamtbetrag|betrag\b/i;

export function looksLikePayment(text) {
  const t = String(text || '');
  return PAYMENT_WORDS.test(t) && PRICE_WORDS.test(t);
}

// Guards against a real, validly-filled payment page for a DIFFERENT hotel than the one actually requested -
// e.g. the agent's own search/autocomplete step picked a similarly-named property, or (on a replay) a stale
// browser-profile session left an old cart from a previous test hotel in place. Word-overlap text-match only
// (no OCR/NLP), the same constraint looksLikePayment already operates under. Exact string equality would be
// too brittle - a site's own displayed name can legitimately drop/abbreviate a word (a location suffix, a
// house-style "Hotel"/"Resort") - but a genuinely wrong hotel does not coincidentally share most of the
// requested name's own distinguishing words. Common, non-distinguishing words are excluded so two DIFFERENT
// "X Hotel" properties can't pass purely on the word "hotel" itself.
const HOTEL_NAME_STOPWORDS = new Set(['hotel', 'resort', 'inn', 'the', 'and', 'by', 'a', 'an', 'of', 'at', 'in', 'on']);

function significantWords(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !HOTEL_NAME_STOPWORDS.has(w));
}

export function matchesRequestedHotel(text, hotelName) {
  const words = significantWords(hotelName);
  if (words.length === 0) return true; // nothing distinctive to check against - don't block on a degenerate name
  const haystack = String(text || '').toLowerCase();
  const matched = words.filter((w) => haystack.includes(w));
  // Most (not necessarily all) of the requested name's own significant words must appear somewhere in the
  // flow's text - tolerates a single dropped/abbreviated word without also accepting a hotel that merely
  // shares one incidental word with a completely different property.
  return matched.length >= Math.max(1, Math.ceil(words.length * 0.6));
}

// A much stronger signal than page text: does the DOM actually contain a card-shaped INPUT field right
// now? A step breadcrumb/nav label that merely *mentions* "payment"/"Zahlung" as an upcoming step (proven
// live, 2026-09: Halalbooking's own step indicator did exactly this on the guest-details page) can trip
// looksLikePayment() without a real payment form anywhere on screen - this cannot, since it requires an
// actual <input> whose accessible name matches a card-field pattern to exist and be visible.
const CARD_FIELD_WORDS = /card number|kartennummer|credit card|kreditkarte|cvv|cvc|carte de cr[ée]dit|num[ée]ro de carte|expiry|expiration/i;

// Real payment processors this check must still catch even though their iframe is cross-origin from the
// booking site itself (PCI compliance requires the card form to live on the processor's own origin, not
// the merchant's). A fixed list of known hosts can never be complete - there are dozens of regional/
// PCI-scoped processors in real use - so it's a belt-and-suspenders addition to the URL-pattern heuristic
// below, not the only line of defense.
const KNOWN_PAYMENT_PROCESSOR_HOSTS = /(^|\.)(stripe\.com|adyen\.com|braintreegateway\.com|braintree-api\.com|checkout\.com|worldpay\.com|paypal\.com|paypalobjects\.com|klarna\.com|squareup\.com|square\.com|authorize\.net|cybersource\.com|payu\.com|razorpay\.com|2checkout\.com|verifone\.com|ingenico\.com|globalpayments\.com|cardinalcommerce\.com|datatrans\.com)$/i;

// Live-verified 2026-09 on Mari Jean Hotel (Mews): the fixed host list above missed Datatrans entirely (a
// real, PCI-compliant Swiss processor Mews happens to use) - `isRelevantFrame` excluded its genuine
// tokenization iframe on every single run, meaning the actual payment page was NEVER once recognized
// programmatically, only ever self-reported by the model. The mirror image of the Agoda false positive this
// module was built to fix: an incomplete allowlist produces a false NEGATIVE instead. A URL-content
// heuristic generalizes past any one list - a genuine card-tokenization iframe's own URL reliably names
// itself as such ("SecureFields", "TOKENIZE", a "/payment/" path segment - true of both Datatrans's
// pay.datatrans.com/upp/payment/SecureFields/paymentField and Agoda's own secure.agoda.com/payment/...),
// while an ad/tracking network's URL (doubleclick, criteo, recaptcha, adsrvr - see the regression test)
// never coincidentally contains any of these.
const PAYMENT_URL_HINT = /\/payment\/|securefield|tokeniz/i;

function registrableDomain(hostname) {
  const parts = hostname.split('.');
  return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

// Live-verified 2026-09 on Agoda: a completely unrelated third-party ad/tracking iframe on the SEARCH
// RESULTS page (the page carries many - doubleclick, criteo, recaptcha, etc.) contained a hidden field
// whose label happened to match CARD_FIELD_WORDS, firing a false "payment page reached" only a few steps
// into a fresh search. Scope the scan to frames that are actually part of the booking flow: same site as
// the main page, a known payment-processor domain, or a frame whose own URL names itself as a card-
// tokenization endpoint (see above). Everything else - ad networks, captcha widgets, unrelated trackers -
// is excluded regardless of its content.
//
// Live-verified 2026-09 on Mari Jean Hotel (Mews): the ENTIRE booking widget - dates, room selection,
// guest details, all of it - lives in a same-page `<iframe>` that was never given a real `src` at all (its
// content is injected directly, not navigated to). Playwright's own Frame.url() for it reports "about:blank"
// forever, regardless of what's actually rendered inside - reading `frame.contentWindow.location.href` from
// page JS shows the real, current URL, but that's not what Playwright's frame-tracking exposes. This is a
// different failure mode from the try/catch below (that catches a genuinely unparseable string; "about:blank"
// parses fine, it's just uninformative) and was silently excluding the ENTIRE page's own visible text -
// including the literal word "Payment" and the booking's own total price - from every check, so the
// real payment page was never once recognized programmatically. An ad/tracking network is never about:blank -
// it always navigates to its own real, identifying URL to serve or track anything - so treating an
// about:blank frame as relevant by default carries none of the false-positive risk this function exists to
// guard against; it only ever helps a legitimate same-page widget be seen.
export function isRelevantFrame(frameUrl, mainUrl) {
  if (frameUrl === 'about:blank' || !frameUrl) return true;
  try {
    const frameHost = new URL(frameUrl).hostname;
    const mainHost = new URL(mainUrl).hostname;
    if (registrableDomain(frameHost) === registrableDomain(mainHost)) return true;
    if (KNOWN_PAYMENT_PROCESSOR_HOSTS.test(frameHost)) return true;
    return PAYMENT_URL_HINT.test(frameUrl);
  } catch {
    return true; // unparseable (data:, etc.) - can't prove it's irrelevant, so don't skip it
  }
}

// Shared by discover.mjs's live loop and bookHotel.mjs's replay-success check - both need the SAME
// cross-frame text (the Mews about:blank-widget case above applies equally to whichever caller is asking).
// The replay path previously read only page.evaluate()'s main-frame text for its own looksLikePayment
// check - a narrower, inconsistent scan than the live Discover loop already used, and exactly the kind of
// gap that would silently hide a same-page iframe's content (hotel name included) from the replay path only.
export async function collectFlowText(page) {
  const mainUrl = page.url();
  return (
    await Promise.all(
      page.frames()
        .filter((f) => isRelevantFrame(f.url(), mainUrl))
        .map((f) => f.evaluate(() => document.body?.innerText || '').catch(() => ''))
    )
  ).join('\n');
}

// Card entry is almost always embedded in a cross-origin <iframe> for PCI compliance (Stripe, Adyen,
// Braintree, etc.) - live-verified 2026-09 on Agoda: the model visually recognized a real, on-screen card
// form and correctly stopped before touching it, but this check (main frame only, at the time) missed it
// entirely and the run was misreported as a failure. Playwright's page.frames() reaches into iframes
// regardless of origin (it drives the browser via CDP, not in-page JS, so same-origin policy doesn't apply)
// - check every RELEVANT frame (see isRelevantFrame), not just the top-level document.
// REGRESSION (found live 2026-09 on Agoda, generic Mumbai SEARCH RESULTS page - surfaced while chasing the
// VND false-negative below, a genuinely separate bug): a search-results page's own sidebar has a real
// filter CHECKBOX literally labeled "Book without credit card" - a standard "no card required to book"
// filter, nothing to do with actually being on a payment page. This function's own CARD_FIELD_WORDS text
// match ("credit card") fired on it, because the input query never excluded non-text-entry control types
// (checkbox/radio/submit/etc.) - the exact isTextEntry distinction hasEmptyRequiredGuestField() below
// already draws, for the identical reason (a checkbox's label/value is never a real card-entry signal).
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
        const isTextEntry = (el) => el.tagName === 'TEXTAREA'
          || el.getAttribute('role') === 'textbox'
          || (el.tagName === 'INPUT' && !['submit', 'button', 'checkbox', 'radio', 'reset', 'image', 'hidden', 'file'].includes((el.getAttribute('type') || 'text').toLowerCase()));
        const inputs = [...document.querySelectorAll('input, [role=textbox]')].filter(visible).filter(isTextEntry);
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

// Live-verified 2026-09 on Mari Jean Hotel (Mews): the model filled ONLY "First name", then the automatic
// payment check fired (Mews puts guest details and the payment section on the SAME page, with no separate
// "continue" boundary between them) and reported success - because requiredFieldsFilled() below only ever
// re-checks fields the trace itself claims were filled, and only "First name" had been tagged. Last name/
// Email/Phone were never attempted at all, sat visibly empty on screen, and were invisible to a check that
// only knows about what it was told about. A genuinely required field the agent never even tried is just as
// real a gap as one it tried and failed - this scans for ANY visible, currently-empty input whose own
// label looks like a standard guest-detail field, independent of what the trace does or doesn't mention.
const GUEST_FIELD_LABEL_WORDS = /first name|last name|full name|guest name|e-?mail|phone|mobile number/i;

export async function hasEmptyRequiredGuestField(page) {
  // Live-verified 2026-09 on Mari Jean Hotel (Mews): with EVERY real guest field genuinely and correctly
  // filled, this still fired - not from a decoy frame (that theory didn't hold up under direct inspection),
  // but from a "marketing-emails-checkbox" opt-in checkbox in the SAME real form, whose own `name`
  // attribute contains "emails" as a substring - enough to match the e-?mail pattern below. A checkbox's
  // `.value` is never a meaningful "is this filled in" signal at all (it's usually a fixed string like "on"
  // regardless of checked state, or empty), so scanning `input` generically catches it as a false "empty
  // required field". Scope to genuine TEXT ENTRY controls only - the same isTextEntry distinction
  // discover.mjs's accessibleName() already draws for exactly this reason.
  // Also require the SAME frame to have at least one matching field that's genuinely non-empty before
  // trusting an "empty" finding there - real proof this is the actual guest-details form, not some
  // unrelated frame that merely happens to contain a coincidentally-matching field.
  const checkFrame = async (frame) => {
    try {
      return await frame.evaluate((pattern) => {
        const re = new RegExp(pattern, 'i');
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const isTextEntry = (el) => el.tagName === 'TEXTAREA'
          || el.getAttribute('role') === 'textbox'
          || (el.tagName === 'INPUT' && !['submit', 'button', 'checkbox', 'radio', 'reset', 'image', 'hidden', 'file'].includes((el.getAttribute('type') || 'text').toLowerCase()));
        const labelFor = (el) => [
          el.getAttribute('aria-label') || '',
          el.getAttribute('placeholder') || '',
          el.name || '',
          el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText || '') : '',
        ].join(' ');
        const matching = [...document.querySelectorAll('input, [role=textbox]')]
          .filter(visible)
          .filter(isTextEntry)
          .filter((el) => re.test(labelFor(el)));
        const hasFilled = matching.some((el) => el.value && el.value.trim());
        const hasEmpty = matching.some((el) => !el.value || !el.value.trim());
        return hasFilled && hasEmpty;
      }, GUEST_FIELD_LABEL_WORDS.source);
    } catch {
      return false;
    }
  };
  const mainUrl = page.url();
  for (const frame of page.frames()) {
    if (!isRelevantFrame(frame.url(), mainUrl)) continue;
    if (await checkFrame(frame)) return true;
  }
  return false;
}

// Live-verified 2026-09 on Mari Jean Hotel (Mews): a run reached genuine success by every OTHER check here
// (payment text+price, real card fields, no field left empty) while the proof screenshot itself showed a
// live, visible error - "Select the country code and enter a valid number" - on the phone field, because
// the fictional number wasn't in a format the site's own validation accepted for its detected country
// context. Every check above asks "is something here", never "does the site itself consider this valid" -
// a materially different, and just as real, way to not actually be done yet. `aria-invalid="true"` is the
// standard, widely-supported ARIA signal for exactly this ("this field's current value failed validation"),
// confirmed present on both the phone input and its country-code selector on the live page - a generic
// check for it costs nothing on sites that don't use it (simply never matches) and directly closes this
// gap on ones that do, without knowing anything site-specific in advance.
export async function hasInvalidField(page) {
  const checkFrame = async (frame) => {
    try {
      return await frame.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return [...document.querySelectorAll('[aria-invalid="true"]')].some(visible);
      });
    } catch {
      return false;
    }
  };
  const mainUrl = page.url();
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
  const emptyGuestField = await hasEmptyRequiredGuestField(page);
  if (process.env.DEBUG_PAYMENT_CHECK) {
    console.error(`[requiredFieldsFilled] hasEmptyRequiredGuestField=${emptyGuestField}`);
  }
  if (emptyGuestField) {
    return { ok: false, missingField: null, reason: 'a visible guest-detail field is still empty (never attempted)' };
  }
  const invalidField = await hasInvalidField(page);
  if (process.env.DEBUG_PAYMENT_CHECK) {
    console.error(`[requiredFieldsFilled] hasInvalidField=${invalidField}`);
  }
  if (invalidField) {
    return { ok: false, missingField: null, reason: 'a field is marked aria-invalid - filled, but rejected by the site\'s own validation' };
  }
  return { ok: true };
}
