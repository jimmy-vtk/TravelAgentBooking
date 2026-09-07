// The core pipeline. See README.md for the full design rationale - this is the direct implementation of
// the pseudocode in the Architecture section: try providers cheapest-first, Replay if we have a recording
// for (hotel, provider), Discover (cold or resumed) otherwise, save/update the recording on success.
// patchright (not plain playwright) - a stealth-patched Chromium that doesn't set navigator.webdriver or
// other stock-Playwright automation fingerprints. Live-verified 2026-09: a real Chrome session sailed
// through a step that every plain-Playwright attempt failed on identically, regardless of session warming
// or form-filling approach - the automation fingerprint itself, not any of our action logic, was the cause.
import { chromium } from 'patchright';
import { mkdirSync, existsSync } from 'node:fs';
import { discover } from './discover.mjs';
import { replay } from './replay.mjs';
import { getRecording, saveRecording } from './recordingStore.mjs';
import { looksLikePayment, hasPaymentInputFields, requiredFieldsFilled } from './verify.mjs';
import { logAttempt } from './costLog.mjs';

function buildGoal({ hotelName, checkIn, checkOut, roomType, guests }, { resuming }) {
  const base = `Book a hotel room.
Hotel: "${hotelName}"
Check-in: ${checkIn}
Check-out: ${checkOut}
${roomType ? `Preferred room type: ${roomType} (use whatever is available if this exact type isn't offered).` : 'Room type: any available.'}
Guests: ${guests}
Guest details to use (fixed, fictional - never real): title/salutation Mr (Herr), first name Max, last name Mustermann, email maxmustermann.abs.test@gmail.com, phone number 1700000000. Enter the phone number as digits only, no spaces/dashes/parentheses, even if it reads less naturally - confirmed live 2026-09 on two separate sites that a space in the phone number can fail native HTML5 validation SILENTLY (no visible error banner or page change at all, so a form that looks fully filled and correct can still refuse to advance on "Continue" with zero visible signal why). If a "Continue"/"Next" click on a guest-details form has no visible effect and every visible field looks correctly filled, suspect the phone number format specifically before anything else - in particular, the fixed phone number above is a German mobile-style number (from a German 0170-prefix placeholder), which is not a valid-FORMAT North American number (no real US/Canada area code starts with a leading 1). If the phone field's own country selector/flag shows the United States or Canada (rather than Germany), some sites run real client-side format validation (e.g. libphonenumber) that silently rejects a German-shaped number under a US/Canada country context with no visible error text at all. In that specific case, use a NANP-valid fictional number instead: any real-looking US/Canada area code followed by 555-01XX (e.g. "5205550100") - the 555-0100 through 555-0199 range is officially reserved by NANPA for exactly this fictional/example purpose and will pass real format validation while remaining guaranteed non-real.
If a title/salutation field (Anrede, Mr/Mrs, Herr/Frau) is present, select it - do not skip it even if it looks optional, a form that appears to "reset" after clicking continue is usually a validation failure on a field you skipped, not an actual reset. This field does NOT exist on every site - check the current screen ONCE; if it's genuinely not there, stop looking for it and move on immediately. Do not re-scroll or re-check for it again after you've already confirmed its absence once - that wastes steps for no benefit.
If the phone number field has a separate country-code dropdown next to it, LEAVE that dropdown at whatever it's already set to (do not change it) - just type the phone number digits into the number field. Changing the country-code dropdown has caused the whole form to visibly clear on at least one real site; the exact code doesn't matter since this data is fictional. Be careful to identify the ACTUAL phone-number text input correctly - on at least one real site (Traveloka) the country-code control next to it is itself a searchable/filterable dropdown that visually resembles a text field, and typing the phone digits into THAT instead of the real number field leaves it in a broken filter state with no numeric input actually entered. If a fill into a phone-adjacent field doesn't visibly show the digits as plain phone-number text afterward, treat it as filled into the wrong element and retarget the real number input.
This rule holds even if the dropdown shows "NotSelected"/a placeholder, or looks mismatched against the phone number's own format (e.g. a Mexico +52 default next to a US-style number) - confirmed live 2026-09 on Mari Jean Hotel (Mews), reproduced twice: the model saw exactly this apparent mismatch, decided to "fix" it by selecting a country from the dropdown despite this rule, the select never visibly took effect (the dropdown kept reporting its old value turn after turn), and the model then burned 10+ steps re-attempting it - never reaching payment on either run as a direct result. If a select on that specific dropdown doesn't visibly register within one retry, STOP touching it entirely and move on to the next step of the flow - a placeholder-looking country code is not itself a validation failure, and is never worth more than one attempt to fix.
Confirmed live 2026-09 on Traveloka, reproduced twice: this exact mistake happens when the element clicked/filled is a small "Phone [down-arrow]" button rather than the actual number field - clicking it OPENS a country-search dropdown with its OWN small search box (a magnifying-glass icon, and "No results found" text once anything is typed) that sits BELOW the "Phone" button, separate from the real, wider phone-number text field beside it. If a screenshot shows a dropdown with a search icon and "No results found" after filling the phone number, that confirms the digits went into this wrong search box, not the real field. Do not type further into that search box or try to fix it in place - click on a neutral, empty area of the page first to close the dropdown (not Escape, which has been observed resetting an entire in-progress form on some sites), THEN click the real, separate, still-empty phone number field beside/below the "Phone" button and type the digits there.
Prefer navigating into the full room list (e.g. a "See rooms"/"Rooms" section) and clicking the "Book" button on a SPECIFIC room card, rather than any shortcut/quick-book button in a summary or sticky panel - a shortcut button has been observed forcing a mandatory login/account-creation step with no guest-checkout option, while the same room booked via its own room-list card did not require login. Never create an account or log in - if a page insists on login/account creation with truly no guest option after trying the room-list path, stop and report why=stuck rather than proceeding.
To reach that room list, prefer SCROLLING DOWN over clicking a "Rooms" tab/nav link - a "Rooms" tab/anchor link has repeatedly been observed to report a successful click while visibly doing nothing (the room list likely only renders once the page is actually scrolled past that point, not on an instant anchor-jump). If you've already tried clicking a "Rooms" link once with no visible effect, don't retry it - just scroll down manually instead.
If a rate is labeled "Pay at hotel" vs "Prepay Online" (the booking BUTTON itself may say "Reserve" either way - that label alone does not tell you which), always prefer "Prepay Online" - a "Pay at hotel" rate has been observed redirecting to an account/phone-verification page instead of the real guest-details form, since guaranteeing a no-card-on-file booking commonly requires identity verification, while "Prepay Online" (even a "pay nothing until [date]" deferred-charge version) reaches the real guest-details form directly. If the site offers a filter/tab for this (e.g. "Prepay Online" vs "Pay at Hotel"), apply it before picking a room.
Do NOT click into a room's photo/name to open a details popup/modal as a step toward booking it - go straight to that room's own rate-line "Reserve"/"Book" button in the room list/table. Opening a details modal first has caused an unrelated, unrecoverable navigation away from the booking flow on at least one real site.
Similarly, do NOT click a "See all N room types"/"N room types" expansion button as a step toward booking - use the "Book" button that's already directly visible on a room card in the default view. A "Book" button reached via that expansion has been observed forcing a mandatory login page with no guest-checkout option, while the exact same room's "Book" button in the default (non-expanded) view did not.
Once a field has been filled/selected AND you've already clicked "Continue"/"Next" to move past the page it was on, do NOT go back and re-click or re-select that same field again "just to double check" - the page has moved on, so that same numbered element reference may now point at something completely different (e.g. a site logo or home link), and clicking it can trigger an unintended navigation back to the homepage, losing the entire booking session. Trust that a field you already filled and successfully advanced past is done; only revisit a field if the CURRENT page you're looking at right now still visibly shows it as empty/unfilled.
After clicking a radio button/checkbox, if the very next screenshot doesn't clearly show it as selected yet, do NOT immediately click it again - a UI can take a moment to visually update, and a same-page click is not the "stale reference after navigating on" case above, but repeatedly re-clicking a control that already registered has still been observed triggering an unintended navigation. Wait for one more screenshot/step before deciding a radio/checkbox click genuinely failed and needs a retry.
If a form demands a real government-issued ID number as a mandatory field to proceed - e.g. an Indian PAN (Permanent Account Number), a national ID, an SSN/tax ID, a passport number with real checksum/format validation - do NOT keep retrying with fictional placeholder values hoping one passes; this data is deliberately never real, and a well-formed fake will simply fail real validation every time. Confirmed live 2026-09 on Cleartrip: PAN is enforced server/client-side ("Pan Number is mandatory", plus real checksum rejection of placeholder values like "ABCDE1234F") on every booking, with no visible way to skip it - this is a structural/regulatory requirement of that specific site (India-domiciled OTA, foreign-currency remittance compliance), not a UI bug. The first time such a field is encountered, try leaving it blank and submitting ONCE to confirm it's truly mandatory (not just optional-looking) - if the resulting error confirms it's required, stop immediately and report why=stuck rather than spending further steps on it.
Use the exact fictional email above (maxmustermann.abs.test@gmail.com), not a reserved/example domain - confirmed live 2026-09 on Traveloka: submitting "test@example.com" was rejected server-side with "Invalid email address. Please use another email," while the identical form with a fake local-part on a real mail domain (gmail.com) was accepted and reached the real payment page cleanly. Some sites validate the email domain itself (not just format), so a reserved domain like example.com/example.org can silently block an otherwise-correct submission.
If a checkbox to create an account (a free membership/loyalty program, e.g. "create a free myHRS account") is present and PRE-CHECKED by default, UNCHECK it before proceeding - never create an account, per the no-login/guest-checkout rule above. Confirmed live 2026-09 on HRS.com: this checkbox is checked by default and reveals a required "Create password" field when left checked; unchecking it removes that field and the form proceeds as a guest. Likewise, if a billing-address section defaults to "Business" (requiring a fictional company name) with a "Private" option available, prefer "Private" - simpler and avoids inventing company details.
A sticky/header summary bar's own "Select room" (or similarly-named) button may be a "scroll down to the offers" shortcut, NOT a submit/continue action - confirmed live 2026-09 on HRS.com: that button did nothing (no navigation) when clicked while already viewing the offers, because its real job is only to scroll the page there. The actual booking action is each individual room/rate card's own "Book now" button lower on the page - use that, not a page-level summary bar button, to proceed past room selection.
Never press Escape OR Enter while inside a booking widget/flow (a room search, guest-details form, etc.) to close a dropdown - confirmed live 2026-09 on a hotel's own Cloudbeds-powered booking site (hotelmccoy.com), reproduced twice independently: the booking flow runs inside an embedded widget, and BOTH Escape and Enter, used to close an open State/Province dropdown, backed the whole widget out to the hotel's regular marketing page, losing the entire in-progress booking (room selection, dates, guest details, everything). A dropdown for a field like State/Province may be a native OS-level select control even inside an embedded widget - its open option list will not appear in a screenshot at all (the capture will look blank/unresponsive while it's open, which is normal, not a hang). The ONLY confirmed-safe way to close and confirm such a dropdown: click it open, press ArrowDown/ArrowUp to reach the desired option (or type its first letter once), then press Tab (never Enter, never Escape, never a mouse click elsewhere on the page) to move focus onward and commit the selection.
A field like ZIP/Postal Code can trigger a slow (several-second) background recalculation after you type into it (e.g. a live tax/rate lookup reflected in a price sidebar) - confirmed live 2026-09 on hotelmccoy.com: immediately after typing into ZIP, the field can appear EMPTY in the very next screenshot even though the value was actually accepted, simply because the async update hadn't settled yet; waiting several seconds before re-checking showed it correctly filled. Two consequences: (1) do not conclude a fill into such a field failed, or retype it, based on a screenshot taken right after - wait a few extra seconds and re-check before deciding it's genuinely empty; (2) that same recalculation can shift the page layout, so fields you fill IMMEDIATELY afterward (e.g. Email, Phone, City right after ZIP) may silently land in the wrong place or fail if you reuse element references/positions from before the ZIP fill - re-observe the current screen fresh before filling anything that comes after a field like ZIP.
On a hotel's own booking site specifically, verify you're on the REAL official site before proceeding, not a near-identical clone/reseller domain - the address, phone number, and email shown in the site's own "Contact"/property-details section should match the hotel's real known address; if a "book direct" link was supplied, prefer navigating there over a generic web search result, since near-identical impersonating domains for hotel booking are a known, real pattern.
On a two-month, side-by-side check-in/check-out RANGE calendar, if a click on what looked like the check-in date instead set check-in to a LATER, wrong date (visible because the search bar now shows the wrong date and every earlier day in the calendar is greyed out/disabled), do NOT keep re-clicking calendar day cells hoping one eventually works - that grey-out is the calendar correctly refusing a checkout date before the (wrong) check-in anchor, not a broken click. Instead click the check-in field/button itself (e.g. a "Check-in, [wrong date]" control) to reset the picker back into check-in-selection mode, then pick the correct check-in date fresh. Confirmed live 2026-09 on a hotel's own Cloudbeds-powered site: this exact mis-click-then-reclick loop burned roughly 10 wasted steps before self-correcting via the reset button - try the reset button after at most one or two failed re-clicks, not ten.`;

  return resuming
    ? `${base}\n\nYou are RESUMING a partially-completed booking on the CURRENT page - do not restart the search or go back. Continue from what's already on screen toward the payment page.`
    : base;
}

// A freshly-launched Playwright context hitting a deep-linked booking URL cold - no cookies, no referrer,
// no browsing history - reads as automated traffic to some sites' fraud/bot heuristics. Live-verified 2026-09
// on Halalbooking: a real browser session with normal cookies/referrer sailed through a click that an
// identical-looking cold Playwright session couldn't get past (a silent form-state reset, not a hard block).
// Visiting the site's own homepage first, letting it settle, then navigating to the actual target gives the
// session a normal-looking referrer chain and a chance to pick up whatever cookies the site sets on arrival -
// cheap, and directly what the trial task's own "warmed-up session" suggestion points at.
async function warmSession(page, targetUrl) {
  try {
    const origin = new URL(targetUrl).origin;
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500 + Math.random() * 1000);
  } catch {
    // homepage warm-up is a best-effort nicety - if it fails, still attempt the real target directly
  }
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

// A persistent, on-disk profile - NOT a fresh context every launch. A brand-new browser context with zero
// cookies/history hitting a booking flow cold is one of the strongest bot signals there is, independent of
// how well the automation fingerprint itself is disguised (live-verified 2026-09: patchright's stealth
// patches alone did not fix a site that a real, aged Chrome profile sailed through). Reusing the same
// directory across runs lets the agent accumulate real cookies/history over time, the same way a genuine
// returning user's browser does - a dedicated profile for this agent, not the operator's personal Chrome.
const PROFILE_DIR = process.env.ABS_PROFILE_DIR || '.abs-profile';
// A naturally-searched flow (as opposed to a pre-built deep link) costs more steps - date-picker fumbling,
// guest-count adjustment, a few retries - live-verified 2026-09 on Trip.com: 25 steps wasn't enough to reach
// checkout even with zero blockers along the way, just legitimate work. Configurable since the right budget
// is genuinely different per provider/flow complexity, not a fixed constant.
const MAX_STEPS = Number(process.env.MAX_STEPS) || 25;

export async function bookHotel({ hotelName, checkIn, checkOut, roomType, guests, providers, onStep }) {
  const params = { hotelName, checkIn, checkOut, roomType, guests };
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    // Default HEADED, not headless - live-verified 2026-09 via a controlled A/B on Traveloka: the SAME
    // network IP, SAME real-Chrome binary (see `channel` below), SAME locale/timezone/persistent-profile/
    // human-paced actions got an explicit "Access is temporarily restricted - bot detection" wall on every
    // headless run (2/2) and sailed all the way to guest-details entry with zero blocks on every headed
    // run (2/2). Headless Chrome - even the real binary, even with every navigator.webdriver-style patch
    // applied - has GPU/WebGL compositing and rendering differences from headed Chrome that sophisticated
    // bot management (Akamai/DataDome/PerimeterX-class systems, which this site's block-page template
    // matches) checks for independently of behavior. Set HEADLESS=1 only for environments with no display.
    headless: process.env.HEADLESS === '1',
    // Without this, patchright launches its own bundled OPEN-SOURCE Chromium build, not the real Google
    // Chrome binary - even with every navigator.webdriver-style JS patch applied, that's a separate,
    // deeper fingerprint gap (no Widevine DRM, different codec licensing, different chrome://version
    // build flags). Real Chrome is what Claude-in-Chrome drives on this same machine/IP, so matching that
    // binary removes one more variable versus the bundled Chromium build, even though the headed-vs-
    // headless distinction above turned out to be the decisive factor for Traveloka specifically.
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
    // Left unset, Playwright/patchright falls back to the OS default locale/timezone, which does not
    // necessarily match what a real user's browser reports - live-verified 2026-09: a manual Chrome session
    // resolved to en-US / Asia/Saigon, and a currency/locale mismatch is one candidate explanation for a
    // reload-back-to-Overview bug seen only in the automated (unset-locale) session on Trip.com. Matching it
    // explicitly removes that variable rather than leaving it to whatever this machine happens to default to.
    locale: process.env.BROWSER_LOCALE || 'en-US',
    timezoneId: process.env.BROWSER_TIMEZONE || 'Asia/Saigon',
  });
  const attempts = [];

  try {
    for (const provider of providers) {
      const page = await context.newPage();
      let result;

      try {
        await warmSession(page, provider.homepage);
        const recording = getRecording(hotelName, provider.name);

        if (recording) {
          const replayResult = await replay(page, recording, params);
          if (!replayResult.broken) {
            const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
            const reallyOnPayment = looksLikePayment(bodyText) && await hasPaymentInputFields(page).catch(() => false);
            const fieldsOk = reallyOnPayment ? await requiredFieldsFilled(page, recording) : { ok: false };
            result = reallyOnPayment && fieldsOk.ok
              ? { success: true, why: 'payment', trace: recording, tookMs: 0, costUsd: 0, apiCalls: 0, replayed: true }
              : { success: false, why: 'stuck', reason: 'replay completed all steps but did not land on a verified payment page', trace: recording };
          } else {
            const discovered = await discover(page, { goal: buildGoal(params, { resuming: true }), onStep, maxSteps: MAX_STEPS });
            if (discovered.success) {
              const merged = [...recording.slice(0, replayResult.brokenAtStep), ...discovered.trace];
              saveRecording(hotelName, provider.name, merged);
            }
            result = { ...discovered, trace: discovered.trace, resumedFromStep: replayResult.brokenAtStep };
          }
        } else {
          const discovered = await discover(page, { goal: buildGoal(params, { resuming: false }), onStep, maxSteps: MAX_STEPS });
          if (discovered.success) saveRecording(hotelName, provider.name, discovered.trace);
          result = discovered;
        }
      } catch (e) {
        result = { success: false, why: 'error', reason: String(e?.message || e) };
      }

      attempts.push({
        provider: provider.name,
        success: !!result.success,
        why: result.why,
        reason: result.reason,
        tookMs: result.tookMs ?? 0,
        costUsd: result.costUsd ?? 0,
        replayed: !!result.replayed,
        resumedFromStep: result.resumedFromStep,
      });
      logAttempt({
        hotelName,
        provider: provider.name,
        status: result.success ? 'success' : (result.why || 'failure'),
        success: result.success,
        why: result.why,
        tookMs: result.tookMs,
        costUsd: result.costUsd,
        apiCalls: result.apiCalls,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        replayed: result.replayed,
        resumedFromStep: result.resumedFromStep,
      });

      // Discover may have followed the flow onto a NEW TAB (some sites open booking in one) - the page
      // actually holding the final state is result.finalPage when that happened, not the original `page`.
      const activePage = result.finalPage || page;

      if (result.success) {
        if (!existsSync('proof')) mkdirSync('proof', { recursive: true });
        const proofPath = `proof/${provider.name.replace(/\W+/g, '_')}_${Date.now()}.png`;
        await activePage.screenshot({ path: proofPath });
        await context.close(); // closes every tab, including the original if a new one was followed - profile data persists on disk
        return {
          status: 'reached_payment',
          provider: provider.name,
          proof: proofPath,
          attempts,
          tookMs: result.tookMs ?? 0,
          costUsd: result.costUsd ?? 0,
        };
      }
      if (activePage !== page) await activePage.close().catch(() => {});
      await page.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {}); // no-op if already closed on the success path above
  }

  return { status: 'needs_review', attempts };
}
