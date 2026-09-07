// The Discover agent: drives a real browser toward a booking's payment page with no prior knowledge of
// the site's structure. DOM/accessibility grounding is the default action target (cheap, stable, survives
// minor layout drift); a raw pixel click is the fallback for anything with no usable role/name (calendar
// day cells, canvas, custom widgets). One model call per step, given both the screenshot and the DOM list
// together - see APPROACH's "vision + DOM combined" note.
//
// Can start cold (fresh navigation already done by the caller) or resume mid-flow on a page a broken
// Replay left behind - same loop either way, the goal prompt just says which.

import Anthropic from '@anthropic-ai/sdk';
import { looksLikePayment, hasPaymentInputFields, requiredFieldsFilled, isRelevantFrame } from './verify.mjs';

// Some API keys are "identity-linked" (issued via SSO/org identity) and require an anthropic-workspace-id
// header telling Anthropic which workspace's billing/quota the request acts in. A plain Console-generated
// key doesn't need this - ANTHROPIC_WORKSPACE_ID is optional and only added when set.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_WORKSPACE_ID
    ? { defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } }
    : {}),
});
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

// Rough USD per 1K tokens - informational only (client asked for a cost figure in the report, not exact billing).
const PRICE_PER_1K_INPUT = 0.003;
const PRICE_PER_1K_OUTPUT = 0.015;

const SYSTEM_PROMPT = `You operate a web browser to book a hotel room. You're given a screenshot and a numbered
list of interactive elements currently on the page (role, accessible name, and current value for inputs).

Reply with EXACTLY one JSON action per turn - no prose, no markdown fences, nothing but the JSON object:
{"action":"click","ref":<element number>,"reason":"..."}
{"action":"click","ref":<element number>,"field":"checkIn"|"checkOut"|"roomType","text":"<see the two rules below>","reason":"..."}   // ONLY for a calendar day-cell click or a room-selection click - see rules
{"action":"fill","ref":<element number>,"text":"<value>","field":"hotelName"|"checkIn"|"checkOut"|"roomType"|"guests"|"firstName"|"lastName"|"email"|"phone"|"title"|null,"reason":"..."}
{"action":"select","ref":<element number>,"text":"<visible option text to pick>","field":"...","reason":"..."}   // for a dropdown/combobox element (role "combobox") - NEVER use "fill" on one of these, always "select"
{"action":"click","x":<px>,"y":<px>,"reason":"..."}   // pixel fallback - ONLY for a target with no element number
{"action":"key","key":"Enter"|"Escape"|"ArrowDown"|"Tab","reason":"..."}
{"action":"scroll","direction":"up"|"down","reason":"..."}
{"action":"wait","reason":"..."}
{"action":"stop","why":"payment"|"captcha"|"stuck"|"dead_end","reason":"..."}

RULES:
- Prefer acting on a numbered element. Only use pixel x/y when your target genuinely has no number - a
  calendar day cell, a custom widget, a canvas.
- When filling a value that comes from the booking goal (hotel name, dates, room type, guest name/email/phone),
  set "field" to which one it is - this is what makes the action reusable as a recording later. A field that's
  NOT one of those (a promo code, a special request) gets "field": null.
- A calendar day-cell CLICK that sets the check-in or check-out date must ALSO be tagged: set "field" to
  "checkIn" or "checkOut" (whichever you're setting) and "text" to that exact date in YYYY-MM-DD format (not
  the calendar's own display text). A recording's date step is otherwise just a click on today's specific day
  cell, with no way to tell a future run with different dates that this step needs re-solving rather than
  reused verbatim - this tag is what makes that possible.
- The CLICK that actually selects a specific room (the "Book"/"Reserve"/"Select room" button on one card/row in
  the room list - NOT a "Rooms" nav tab, NOT a details-modal open) must ALSO be tagged: set "field" to
  "roomType" and "text" to that room's own displayed name exactly as shown. Same reason - a future run asking
  for a different room type needs to know to re-pick here instead of reusing today's choice.
- Dismiss a cookie/consent banner or a "continue as guest" prompt first, only if one is actually visible.
- Search box with an autocomplete dropdown: after filling, press ArrowDown then Enter, or click the matching
  suggestion directly if it's in the numbered list.
- Date picker: read the displayed month/year, navigate to the target month, then click the day cell. Check the
  numbered element list FIRST for that day - look for a button/gridcell whose accessible name is or contains
  the full target date (e.g. "Tue Oct 20 2026", "date-cell-20-10-2026"), not just the bare day-of-month digit.
  Many sites DO number their day cells this way - use that numbered ref, since a pixel click can't be replayed
  deterministically later. Only fall back to a raw pixel click if no numbered element matches the target date
  at all.
- NEVER solve a CAPTCHA - if one appears: {"action":"stop","why":"captcha"}.
- NEVER enter payment/card data, NEVER click a final "Pay"/"Confirm and pay"/"Complete booking" button.
- Multi-step checkouts commonly have a "Review"/"Confirm your booking" summary page BETWEEN guest details and
  the actual payment page - it shows the final price and your selections, but has no card/payment fields yet,
  and its own button says something like "Continue to Payment"/"Proceed to Payment" (a NAVIGATION button, not a
  charge). That review page is NOT the payment page - clicking a navigation-only "Continue to Payment" button
  is safe (it does not charge anything or submit any payment) and is required to actually reach the real
  payment page. Only stop once you're on a page that either asks for card/payment details directly, OR whose
  own button would actually CHARGE/CONFIRM the booking (e.g. "Pay now", "Confirm and Pay", "Complete Booking",
  "Place Order") - that button itself must never be clicked, but reaching the page it's on is the goal.
- STOP the moment the CURRENT page is that genuine payment/checkout page: {"action":"stop","why":"payment"}.
  Every required field you've filled so far (guest name, email, phone, etc.) must actually be filled in before
  you stop - if you reach what looks like the payment page but a required field from an earlier step is still
  empty, go back and fill it first.
- If nothing has changed for 3 turns, or you see no way forward: {"action":"stop","why":"stuck"}.
- If the room/hotel is unavailable (sold out, no results): {"action":"stop","why":"dead_end"}.
- If a room/rate list appears EMPTY after navigating via a tab or in-page section link, that tab/link may only
  scroll to an anchor without actually loading data. Before concluding no availability, look for a dedicated
  "Reserve"/"Select room"/"Book now"/"More options" button elsewhere on the page (often in a sticky price
  summary card) - clicking that is often what actually triggers the room list to load.
- On a hotel property page specifically: prefer a STICKY/FLOATING price-summary panel (usually anchored to
  the page, showing a price and ONE button like "Reserve"/"Select Rooms"/"More options") over a top navigation
  TAB labeled "Rooms" - the nav tab is often just an in-page anchor link that scrolls without loading data,
  while the price panel's own button is what actually triggers the room list. If you've already tried a "Rooms"
  tab or a "Select Rooms"/"More options" click once with no effect, do NOT click it again - scroll to find the
  price summary panel specifically (it's commonly near the top of the page, close to the hotel name/rating, or
  docked to a corner) and click its button instead.`;

// Promotional/marketing modals (partner offers, PayLater upsells, "download the app") cost real budget when
// the model has to notice and click their close button as its own reasoned step - live-verified 2026-09 on
// Tiket.com in headed mode: a stack of these ate most of a run before it ever got back to the room list.
// Closing them deterministically, with no model call, is both cheaper and faster. Scoped narrowly (only
// buttons whose own text/aria-label reads as a close action, only inside containers that look like a modal/
// overlay/popup) and explicitly excludes anything calendar/date-picker-ish, since a date picker is a
// legitimate overlay the agent needs to stay open across several clicks (e.g. picking check-in then
// check-out) - closing it out from under the agent would break that flow.
export async function dismissOverlays(page) {
  try {
    const dismissed = await page.evaluate(() => {
      const closeTextRe = /^(close|dismiss|no,? thanks|not now|skip|got it|maybe later|×|✕|x)$/i;
      const excludeRe = /calendar|datepicker|date-picker/i;
      const containers = document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="overlay" i]'
      );
      const candidates = new Set();
      for (const container of containers) {
        if (excludeRe.test(container.className || '')) continue;
        const rect = container.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) continue;
        container.querySelectorAll('button, [role="button"], a').forEach((btn) => {
          const label = (btn.getAttribute('aria-label') || btn.textContent || '').trim();
          if (closeTextRe.test(label)) candidates.add(btn);
        });
      }
      let count = 0;
      for (const btn of candidates) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          btn.click();
          count++;
        }
      }
      return count;
    });
    if (dismissed > 0) await page.waitForTimeout(300);
    return dismissed;
  } catch {
    return 0;
  }
}

// Runs entirely INSIDE one frame's own document (main page or a nested iframe) - see the frame-traversal
// wrapper below for why this had to become a per-frame function instead of a single page.evaluate() call.
async function getFrameElements(frame, startRef) {
  return frame.evaluate((startRef) => {
    function accessibleName(el) {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      // A very common labeling pattern we were missing entirely - live-verified 2026-09 on Agoda: its guest-
      // details fields use aria-labelledby (not label[for] or a placeholder), so every one of them fell all
      // the way through to the el.value fallback below.
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim();
        if (text) return text.slice(0, 80);
      }
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
      }
      // A <label> that WRAPS the input instead of using for/id (the other common pattern besides label[for]).
      const wrappingLabel = el.closest('label');
      if (wrappingLabel && wrappingLabel.innerText.trim()) return wrappingLabel.innerText.trim();
      const ph = el.getAttribute('placeholder');
      if (ph) return ph.trim();
      // A <select>'s innerText is EVERY <option>'s text concatenated - a phone country-code picker with
      // 200+ options turned into a multi-hundred-character garbled "name" this way, live-verified 2026-09,
      // and wasted most of a run's step budget. Use the currently selected option's own text instead.
      if (el.tagName === 'SELECT') {
        const selected = el.options[el.selectedIndex];
        if (selected && selected.text.trim()) return selected.text.trim().slice(0, 80);
        return '';
      }
      // el.value is only a legitimate "name" for a button-like control (e.g. <input type="submit"
      // value="Book Now"> genuinely renders that value as its visible label). For a genuine text-entry
      // field it is NOT a name at all - it's the field's current, ever-changing CONTENT. Using it as a
      // fallback here made an unfilled field's name "" and a filled one's name whatever was just typed into
      // it (live-verified 2026-09: "Max" leaked into a completely different field's recorded name this way),
      // an unstable identity that also corrupts recordings for replay. Never use it for a text-entry field.
      const isTextEntry = el.tagName === 'TEXTAREA'
        || (el.tagName === 'INPUT' && !['submit', 'button', 'checkbox', 'radio', 'reset', 'image'].includes((el.getAttribute('type') || 'text').toLowerCase()));
      const txt = (el.innerText || (isTextEntry ? '' : el.value) || '').trim();
      // A short (<=3 char) innerText - typically a bare day-of-month number on a calendar cell - is
      // inherently ambiguous: the SAME text ("1", "8", ...) recurs once per visible month, and multiple
      // months are commonly pre-rendered in the DOM at once even off-screen. Live-verified 2026-09 on
      // Traveloka: every such cell also carries a data-testid encoding the real, unique date (e.g.
      // "date-cell-1-10-2026" for Oct 1 2026) - prefer that specific, disambiguating identifier over the
      // bare "1" whenever the innerText is this short, rather than only using data-testid as a last resort.
      if (txt && txt.length > 3) return txt.slice(0, 80);
      const testId = el.getAttribute('data-testid');
      if (txt && txt.length <= 3 && testId) return testId.trim().slice(0, 80);
      if (txt) return txt.slice(0, 80);
      const title = el.getAttribute('title');
      if (title) return title.trim();
      return '';
    }
    function role(el) {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'submit' || t === 'button') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        return 'textbox';
      }
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      return 'generic';
    }
    // [tabindex] catches framework-rendered "click targets" that are plain <div>s with no semantic
    // role/onclick attribute at all - live-verified 2026-09 on Traveloka (react-native-web output): an
    // autocomplete suggestion row and a calendar day cell are BOTH bare divs, invisible to every selector
    // above (no href/button/input tag, no role, no inline onclick - the click is a React-delegated
    // listener), yet both resolve to an ancestor div carrying tabindex="0" with cursor:pointer. Without
    // this, such elements never get numbered at all and Discover falls back to a raw x/y pixel click -
    // which accessibleName() can still often name correctly via its innerText fallback below, but which
    // replay.mjs treats as an unconditional, unrecoverable break (no role/name to re-locate by), since a
    // bare coordinate isn't stable across sessions the way a real element reference is.
    const candidates = [...document.querySelectorAll(
      'a[href], button, input, select, textarea, [role=button], [role=option], [role=combobox], [onclick], [tabindex]'
    )];
    // Scoped to the CURRENT VIEWPORT, not just "has size and isn't display:none" - live-verified 2026-09 on
    // Trip.com: a page with 170+ interactive elements had a working "Reserve" button at index 39 (well
    // within the old 60-element cap), but 1798px down on a 945px-tall viewport - present in the numbered
    // list, invisible in the screenshot. The model reasonably distrusted a numbered item it couldn't see and
    // kept clicking whatever WAS on screen instead, looping for 20+ steps. A little slack (±80px) covers an
    // element that's mostly but not 100% in frame.
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const inViewport = r.bottom > -80 && r.top < window.innerHeight + 80;
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && inViewport;
    };
    const out = [];
    let i = startRef;
    for (const el of candidates) {
      if (!visible(el)) continue;
      if (i - startRef >= 60) break;
      el.setAttribute('data-agent-ref', String(i));
      out.push({
        ref: i,
        role: role(el),
        name: accessibleName(el),
        value: 'value' in el ? String(el.value || '') : '',
      });
      i++;
    }
    return out;
  }, startRef);
}

// Booking widgets are commonly embedded as a same-page <iframe> (a full booking-engine SPA, not just a
// PCI-scoped card form) - live-verified 2026-09 on Mari Jean Hotel (Mews-powered): the outer page has
// LITERALLY ZERO buttons/inputs of its own; the entire flow - dates, room selection, guest details,
// everything - lives inside `<iframe class="mews-distributor">`. page.evaluate() only ever runs in the
// main frame by design, so every single interaction on that whole site was falling through to a raw pixel
// click, the exact thing this numbered-element system exists to avoid - unreliable, and permanently
// unreplayable (replay.mjs hard-breaks on any step with no role/name, which pixel-only steps always are).
// page.frames() reaches every frame regardless of origin (CDP-driven, not in-page JS), same as the payment-
// detection checks in verify.mjs already rely on. Each element remembers which Frame it came from so
// executeAction() can build its locator against the RIGHT frame - page.locator() alone never pierces an
// iframe boundary, even same-origin.
export async function getInteractiveElements(page) {
  const out = [];
  for (const frame of page.frames()) {
    if (out.length >= 60) break;
    let elements;
    try {
      elements = await getFrameElements(frame, out.length);
    } catch {
      continue; // detached, cross-origin-blocked, or mid-navigation - skip this frame, not fatal
    }
    for (const el of elements) out.push({ ...el, frame });
  }
  return out;
}

function renderElementList(elements) {
  return elements
    .map((e) => `#${e.ref} [${e.role}] "${e.name}"${e.value ? ` (current value: "${e.value}")` : ''}`)
    .join('\n');
}

async function askModel({ goal, elements, screenshotB64, history, usage, lastError }) {
  const historyText = history.slice(-8).map((h, i) => `${i + 1}. ${h}`).join('\n') || '(nothing yet)';
  const errorHint = lastError
    ? `\n\nYour PREVIOUS reply could not be used (${lastError}). Reply with EXACTLY one JSON object, no prose, no code fences, no trailing text.`
    : '';

  const msg = await anthropic.messages.create({
    model: MODEL,
    // Bumped from 600 - live-verified 2026-09 re-solving a Traveloka date change: the model got visibly
    // uncertain after a calendar click didn't obviously register (no clear visual diff), wrote a longer
    // "reason" while reasoning about it, and got cut off mid-JSON twice in a row at the exact same step -
    // "unparseable model output (no JSON object found)". More headroom costs a little on the rare turns
    // that use it and fixes truncation outright the rest of the time.
    max_tokens: 1024,
    system: `${SYSTEM_PROMPT}\n\nGOAL:\n${goal}`,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `ACTIONS SO FAR:\n${historyText}\n\nINTERACTIVE ELEMENTS ON SCREEN:\n${renderElementList(elements)}\n\nReturn exactly one JSON action.${errorHint}`,
        },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
      ],
    }],
  });

  if (msg.usage) {
    usage.inputTokens += msg.usage.input_tokens || 0;
    usage.outputTokens += msg.usage.output_tokens || 0;
    usage.calls += 1;
  }

  const textBlock = msg.content.find((b) => b.type === 'text');
  const raw = textBlock ? textBlock.text : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { action: 'error', reason: 'unparseable model output (no JSON object found)' };
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed.action) return { action: 'error', reason: 'JSON parsed but had no "action" field' };
    return parsed;
  } catch {
    return { action: 'error', reason: 'invalid JSON from model' };
  }
}

// A single model call is retried up to 3 times on a parse/format failure (truncation, stray prose, a
// half-written object) before this step is treated as a genuine dead end - the same call succeeding on
// retry #2 should not cost the whole run.
async function askModelWithRetry(params) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const action = await askModel({ ...params, lastError });
    if (action.action !== 'error') return action;
    lastError = action.reason;
  }
  return { action: 'stop', why: 'stuck', reason: `model kept returning unusable output: ${lastError}` };
}

// A whole multi-field form filled in well under a second (our .fill()/.selectOption() calls run back to
// back with no gap) is itself a bot signal some fraud-detection systems key off, independent of any
// per-action event-trust concern - live-verified 2026-09 on Halalbooking: every field in the guest-details
// form fills with no individual error, and only once the LAST field is filled does the whole form come back
// empty, which fits a "filled too fast to be human" heuristic better than a per-field one. A short randomized
// pause before each fill/select approximates realistic human pacing between form fields.
async function humanPause() {
  await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 700));
}

export async function executeAction(page, action, elements) {
  const target = elements.find((e) => e.ref === action.ref);
  if (action.action === 'click') {
    await humanPause();
    if (target && (target.role === 'radio' || target.role === 'checkbox')) {
      // A generic .click() on a radio/checkbox has been observed - live-verified 2026-09 on Tiket.com,
      // multiple independent instances of the same title/salutation radio control - occasionally triggering
      // an unrelated full-page reset back to the homepage, losing the whole booking session. .check() is
      // Playwright's purpose-built method for exactly this state change (rather than a generic click at the
      // element's center) and is worth trying first; fall back to a plain click if it's not a real
      // checkable input (e.g. a div styled to look like a radio).
      const loc = target.frame.locator(`[data-agent-ref="${action.ref}"]`).first();
      await loc.check({ timeout: 5000 }).catch(() => loc.click({ timeout: 5000 }).catch(() => {}));
    } else if (target) {
      await target.frame.locator(`[data-agent-ref="${action.ref}"]`).first().click({ timeout: 5000 }).catch(() => {});
    } else if (action.x != null) {
      await page.mouse.click(action.x, action.y);
    }
  } else if (action.action === 'fill') {
    if (target) {
      await humanPause();
      const loc = target.frame.locator(`[data-agent-ref="${action.ref}"]`).first();
      try {
        // .fill() sets the value AND fires the input/change events a React-controlled field expects,
        // atomically - a manual click+select-all+type sequence (the previous approach) proved unreliable
        // on at least one real site: fields that visually accepted the typed text still read back as
        // empty at native HTML5 validation time, live-verified 2026-09.
        await loc.fill(action.text || '', { timeout: 5000 });
      } catch {
        // not a plain fillable input (e.g. a custom combobox) - fall back to click+type
        await loc.click({ timeout: 5000 }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.type(action.text || '');
      }
      // A live-masked input (a phone field that reformats digits as you type) can silently DROP leading
      // characters when set atomically by .fill() - live-verified 2026-09 on Mari Jean Hotel (Mews):
      // filling "5205550100" in one shot reproducibly read back as "05550100", losing exactly the leading
      // "52" - a fast, all-at-once value-set outrunning the field's own reformat-as-you-type logic.
      // Confirmed directly (not just inferred): typing the exact same digits with a real ~1s per-key pace
      // read back correctly as "520 555 0100"; Playwright's own default .type() pacing was already too
      // fast for this specific field. Detect the mismatch and retry with genuinely slow, incremental
      // per-character typing - deliberately well past what's actually needed, since this only runs once
      // as a fallback and reliability matters far more than the couple of extra seconds it costs.
      if (action.text && /phone|mobile|tel\b/i.test(target.name || '')) {
        // Strip non-digits from BOTH sides before comparing - live-verified 2026-09 the settled value
        // itself comes back auto-formatted with spaces ("520 555 0100"), which would break a raw
        // contiguous-substring match against the unformatted digits even when the fill is actually correct.
        // Compare the FULL digit string, not just a suffix - the actual bug drops LEADING characters
        // ("5205550100" -> "05550100"), which still contains any suffix of the original completely intact,
        // so checking only the last few digits would never catch this exact failure mode at all.
        const settledDigits = (await loc.inputValue({ timeout: 2000 }).catch(() => '')).replace(/\D/g, '');
        if (!settledDigits.includes(String(action.text).replace(/\D/g, ''))) {
          await loc.click({ timeout: 5000 }).catch(() => {});
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.press('Backspace').catch(() => {});
          for (const ch of String(action.text)) {
            await page.keyboard.type(ch);
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      }
    } else if (action.x != null) {
      await page.mouse.click(action.x, action.y);
      await page.keyboard.type(action.text || '');
    }
  } else if (action.action === 'select') {
    if (target) {
      await humanPause();
      const loc = target.frame.locator(`[data-agent-ref="${action.ref}"]`).first();
      const needle = (action.text || '').trim().toLowerCase();
      // selectOption() sets the value via JS injection and its input/change events are NOT isTrusted -
      // live-verified 2026-09 on Halalbooking: selectOption() on the Anrede (title) field returns success
      // with no error, but the site's own submit-time validation treats the field as still unset and clears
      // the whole form, over and over. A real, un-simulatable Chrome session sailed through the identical
      // field/value with a real click + arrow-key selection. Keyboard navigation on a focused <select> fires
      // genuine browser-native change events, so try that first; fall back to selectOption for anything a
      // short arrow-key walk can't reach (e.g. a 200+ option country-code picker - confirmed live 2026-09
      // that selectOption is fine there, and this path is never used on that field per the goal prompt).
      let usedKeyboard = false;
      try {
        const matchedIndex = await loc.evaluate((el, n) => {
          const opts = [...el.options];
          let idx = opts.findIndex((o) => o.text.trim().toLowerCase() === n);
          if (idx < 0) idx = opts.findIndex((o) => o.text.trim().toLowerCase().includes(n));
          return { idx, current: el.selectedIndex };
        }, needle);
        const steps = matchedIndex.idx >= 0 ? matchedIndex.idx - matchedIndex.current : NaN;
        if (!Number.isNaN(steps) && Math.abs(steps) <= 40) {
          await loc.click({ timeout: 5000 });
          const key = steps > 0 ? 'ArrowDown' : 'ArrowUp';
          for (let i = 0; i < Math.abs(steps); i++) await page.keyboard.press(key);
          // Tab, not Enter, to close/confirm - each arrow press already fires a native 'change' event on
          // its own (that's the whole point of this keyboard path over selectOption(), see above), so
          // Enter here was only ever closing the dropdown, never doing additional state work. Live-verified
          // 2026-09 on a hotel's own Cloudbeds-powered booking site: pressing Enter to close a State/Province
          // <select> - even one embedded inside a same-page widget, not a real form submit - reset the ENTIRE
          // booking flow back to the site's marketing homepage, losing every field filled so far. Tab moves
          // focus onward without that risk and was confirmed safe on the same widget.
          await page.keyboard.press('Tab').catch(() => {});
          usedKeyboard = true;
        }
      } catch {
        // fall through to selectOption below
      }
      if (!usedKeyboard) {
        try {
          await loc.selectOption({ label: action.text || '' }, { timeout: 5000 });
        } catch {
          const value = await loc.evaluate((el, n) => {
            const opt = [...el.options].find((o) => o.text.toLowerCase().includes(n));
            return opt ? opt.value : null;
          }, needle).catch(() => null);
          if (value != null) await loc.selectOption({ value }, { timeout: 5000 }).catch(() => {});
        }
      }
    }
  } else if (action.action === 'key') {
    await page.keyboard.press(action.key).catch(() => {});
  } else if (action.action === 'scroll') {
    // A single, perfectly identical 400px wheel delta on every scroll is itself a mechanical fingerprint,
    // independent of timing - live-verified 2026-09 on Tiket.com: 15+ consecutive scrolls of exactly this
    // shape preceded navigation being silently lost back to the homepage. A real scroll wheel produces
    // several smaller, variably-sized deltas per gesture, not one large fixed jump, with tiny pauses
    // between them - approximate that instead of one uniform wheel() call.
    await humanPause();
    const dir = action.direction === 'up' ? -1 : 1;
    const ticks = 2 + Math.floor(Math.random() * 2);
    for (let t = 0; t < ticks; t++) {
      await page.mouse.wheel(0, dir * (120 + Math.floor(Math.random() * 100)));
      await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120));
    }
  } else if (action.action === 'wait') {
    await page.waitForTimeout(1500);
  }
}

export async function discover(page0, { goal, maxSteps = 25, onStep } = {}) {
  const startedAt = Date.now();
  const history = [];
  const trace = [];
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const context = page0.context();
  // Some sites open the actual booking flow in a NEW TAB (a "Check Availability"/"Book Now" button with
  // target=_blank, or a popup window) rather than navigating the current one - live-verified 2026-09 on
  // Trip.com. `page` is reassigned below whenever a new tab appears, so the loop follows it automatically.
  let page = page0;

  const finish = (fields) => {
    const tookMs = Date.now() - startedAt;
    const costUsd = (usage.inputTokens / 1000) * PRICE_PER_1K_INPUT + (usage.outputTokens / 1000) * PRICE_PER_1K_OUTPUT;
    return {
      trace, tookMs, costUsd, apiCalls: usage.calls,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      finalPage: page, ...fields,
    };
  };

  for (let step = 0; step < maxSteps; step++) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(400);
    await dismissOverlays(page);

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    // Same cross-origin blind spot as the input-field check below, and the same fix: live-verified 2026-09
    // on Agoda, hasPaymentInputFields() correctly found the card iframe's fields, but looksLikePayment()
    // still failed because bodyText above is main-frame-only text and Agoda's actual "payment"/card wording
    // lives inside that same secure.agoda.com iframe, not the outer page. Aggregate text across every frame
    // for the payment-text check specifically (bodyText itself stays main-frame-only - it also feeds the
    // cheap no-visible-effect signature below, which doesn't need this).
    const mainUrl = page.url();
    // Same scoping as hasPaymentInputFields() (see verify.mjs's isRelevantFrame) - live-verified 2026-09 on
    // Agoda, an unrelated third-party ad iframe's text alone was enough to satisfy PAYMENT_WORDS+PRICE_WORDS
    // on the search-results page. Aggregate text only from frames that are actually part of the booking
    // flow, not every ad/tracking iframe the page happens to load.
    const allFramesText = (
      await Promise.all(
        page.frames()
          .filter((f) => isRelevantFrame(f.url(), mainUrl))
          .map((f) => f.evaluate(() => document.body?.innerText || '').catch(() => ''))
      )
    ).join('\n');
    // Text match alone is a false-positive risk (a step breadcrumb can mention "payment"/"Zahlung" as an
    // upcoming step's label without an actual payment form present) - require a real card-shaped input
    // field in the DOM too before treating this as the payment page at all. A real card form is commonly
    // a cross-origin iframe (PCI compliance) that can take noticeably longer than the rest of the page to
    // render its own inputs - live-verified 2026-09 on Agoda: the model's own screenshot-based judgement
    // (taken, then round-tripped through the API - a few seconds later) caught the card form fine, while
    // this earlier, fixed-delay check missed it and the run was misreported as a failure. Retry briefly
    // before giving up, rather than falling through to the always-untrusted model self-report path.
    let paymentInputsPresent = await hasPaymentInputFields(page).catch(() => false);
    if (process.env.DEBUG_PAYMENT_CHECK) {
      console.error(`[payment-check] step=${step} looksLikePayment=${looksLikePayment(allFramesText)} paymentInputsPresent=${paymentInputsPresent} frames=${page.frames().map((f) => f.url()).join(' | ')}`);
      console.error(`[payment-check] allFramesText.length=${allFramesText.length} sample=${JSON.stringify(allFramesText.slice(-300))}`);
      const relevantUrls = page.frames().filter((f) => isRelevantFrame(f.url(), mainUrl)).map((f) => f.url());
      console.error(`[payment-check] relevantFrameUrls=${JSON.stringify(relevantUrls)}`);
    }
    if (looksLikePayment(allFramesText) && !paymentInputsPresent) {
      for (let i = 0; i < 3 && !paymentInputsPresent; i++) {
        await page.waitForTimeout(800);
        paymentInputsPresent = await hasPaymentInputFields(page).catch(() => false);
      }
      if (process.env.DEBUG_PAYMENT_CHECK) {
        console.error(`[payment-check] step=${step} after retries paymentInputsPresent=${paymentInputsPresent}`);
      }
    }
    if (looksLikePayment(allFramesText) && paymentInputsPresent) {
      const fieldsOk = await requiredFieldsFilled(page, trace);
      if (fieldsOk.ok) {
        onStep?.({ step, action: 'stop', reason: 'payment_detected_programmatically' });
        return finish({ success: true, why: 'payment' });
      }
      // page looks like payment but a required field is empty - not success yet, keep going and let the
      // model see it (the prompt tells it to notice and go back and fill the gap).
    }

    const elements = await getInteractiveElements(page);
    const screenshotB64 = (await page.screenshot()).toString('base64');
    if (process.env.DEBUG_SHOTS) {
      const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
      if (!existsSync(process.env.DEBUG_SHOTS)) mkdirSync(process.env.DEBUG_SHOTS, { recursive: true });
      writeFileSync(`${process.env.DEBUG_SHOTS}/step-${String(step).padStart(2, '0')}.png`, Buffer.from(screenshotB64, 'base64'));
    }
    const action = await askModelWithRetry({ goal, elements, screenshotB64, history, usage });

    if (action.action === 'stop') {
      onStep?.({ step, action: 'stop', why: action.why, reason: action.reason });
      return finish({ success: false, why: action.why });
    }

    const target = elements.find((e) => e.ref === action.ref);
    const stepRecord = {
      action: action.action,
      role: target ? target.role : null,
      name: target ? target.name : null,
      x: target ? null : (action.x ?? null),
      y: target ? null : (action.y ?? null),
      // A click tagged with a field (checkIn/checkOut/roomType - see SYSTEM_PROMPT) carries its own "text"
      // too, same as fill/select: that's what lets replay tell a stale date/room-choice click apart from one
      // that still matches what THIS run actually needs, instead of blindly replaying today's date forever.
      text: (action.action === 'fill' || action.action === 'select' || (action.action === 'click' && action.field)) ? action.text : undefined,
      field: action.field ?? null,
      key: action.key,
      direction: action.direction,
    };
    trace.push(stepRecord);
    onStep?.({ step, ...stepRecord, reason: action.reason });

    // Cheap "did anything actually happen" signature - url + interactive element count + body text length.
    // Not a semantic diff, just enough to catch "clicked but the page is identical" (this is what was
    // missing when the model kept re-clicking a nearby "Select Rooms"/"Rooms tab" element that turned out
    // to be a no-op: it had no way to tell its own click hadn't worked, live-verified 2026-09).
    const before = { url: page.url(), elCount: elements.length, textLen: bodyText.length };

    await executeAction(page, action, elements);
    await page.waitForTimeout(700).catch(() => {});
    // A ZIP/postal-code field can trigger a slow (multi-second) background recalculation after typing
    // (e.g. a live tax/rate lookup) - live-verified 2026-09 on a hotel's own Cloudbeds-powered booking
    // site: the field (and fields filled right after it) could read back as empty in the very next
    // screenshot purely because that async update hadn't settled yet, not because the fill failed. Relying
    // on the model to notice and insert its own extra wait proved unreliable in practice, so guarantee the
    // settle time here instead of only via prompt guidance.
    if (action.action === 'fill' && target && /zip|postal/i.test(target.name || '')) {
      await page.waitForTimeout(4000).catch(() => {});
    }

    let noEffectNote = '';
    if (action.action === 'click') {
      const afterText = await page.evaluate(() => document.body.innerText).catch(() => '');
      const afterEls = await getInteractiveElements(page).catch(() => []);
      const after = { url: page.url(), elCount: afterEls.length, textLen: afterText.length };
      if (before.url === after.url && before.elCount === after.elCount && before.textLen === after.textLen) {
        noEffectNote = ' [NO VISIBLE EFFECT - this click changed nothing; do NOT repeat it, pick a genuinely different element next]';
      }
    }

    history.push(
      `${action.action}${target ? ` [${target.role} "${target.name}"]` : ''}${action.text ? ` = "${action.text}"` : ''} — ${action.reason || ''}${noEffectNote}`
    );

    // Did that action open a new tab/window? Follow it - the newest open page becomes the one we act on.
    const openPages = context.pages().filter((p) => !p.isClosed());
    if (openPages.length > 1) {
      const newest = openPages[openPages.length - 1];
      if (newest !== page) {
        await newest.bringToFront().catch(() => {});
        await newest.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        page = newest;
        history.push('(a new tab opened - now operating on it)');
      }
    }
  }

  return finish({ success: false, why: 'max_steps' });
}
