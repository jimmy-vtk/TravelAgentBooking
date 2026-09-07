// Deterministic replay of a saved recording. No model call. A step is located by (role, name) - the
// same accessible-name grounding Discover used to record it - not by a raw index, so it survives minor
// reordering/relayout as long as the element itself is still there.
//
// Real sites don't show the same sequence of interstitials on every visit - live-verified 2026-09 on
// Agoda: a "Dismiss" banner click in a saved recording broke replay outright on a later run because that
// banner simply didn't appear that time, even though the underlying booking flow (including real scroll
// steps right after it) was unchanged. A first attempt at fixing this peeked ahead at LATER steps'
// presence before deciding to skip - but that fails whenever the steps in between are 'scroll' (nothing to
// check presence of at all) followed by a click that genuinely isn't clickable YET because the page hasn't
// actually been scrolled there. The simpler, correct rule: a failed 'click' just gets skipped outright and
// the loop moves on immediately - the next real step (even a physical scroll) still runs normally, which
// is what actually gets the flow to the right place. This is plain DOM presence-checking - no model call -
// so it stays true to "replay is the cheap, deterministic path." A short cap on CONSECUTIVE click-skips
// keeps this from silently no-op'ing through an entire recording if the page has genuinely drifted, rather
// than just skipping past one or two optional interstitials. dismissOverlays() (the same deterministic
// promo/popup closer Discover uses) also runs before every located step here, since an unrecorded
// interstitial (one that never showed up during the original Discover run at all) is just as real a
// possibility.
//
// 'fill'/'select' never get skipped - they represent required data entry (guest name, email, phone, a rate
// choice), and silently skipping one because it can't be found could produce an incomplete submission that
// requiredFieldsFilled() would never even see, since a skipped step never lands in the trace at all. A
// missing required field - or any step recorded with no role/name at all (a raw pixel-coordinate fallback,
// nothing stable to re-locate regardless of action type) - is always a genuine break, handed to Discover to
// actually re-solve, not something to guess past.
//
// A step that can't be found or acted on within the timeout - and isn't skip-eligible - is "broken": replay
// stops immediately and reports exactly which step index failed. The caller (bookHotel) hands the same
// live `page` to Discover to resume from there - the steps that already ran are NOT re-run and NOT discarded.

import { dismissOverlays } from './discover.mjs';

const MAX_CONSECUTIVE_CLICK_SKIPS = 2;

// A recorded date/room-selection CLICK's own locator name IS the value ("date-cell-1-10-2026", a specific
// room's display name) - unlike fill/select, there's no generic way to substitute a NEW date/room into that
// locator string for an arbitrary site's own naming scheme. Recognizing that the requested value has actually
// CHANGED and treating the step as broken - handing it to Discover to re-solve live, the same partial-resume
// path already used for real drift - is far more robust than trying to pattern-match/rewrite an unknown site's
// date-cell naming convention. Only forces a break when the value genuinely differs; unset/unrequested
// (roomType with no preference) never forces one, matching "room type is a preference, not a hard filter."
function valueChanged(step, params) {
  if (!step.field || !step.text) return false;
  if (step.field === 'checkIn' || step.field === 'checkOut') {
    return Boolean(params[step.field]) && params[step.field] !== step.text;
  }
  if (step.field === 'roomType') {
    if (!params.roomType) return false;
    return String(params.roomType).trim().toLowerCase() !== step.text.trim().toLowerCase();
  }
  return false;
}

async function tryStep(page, step, params) {
  try {
    const loc = page.getByRole(step.role, { name: step.name, exact: false }).first();
    await loc.waitFor({ timeout: 5000 });
    if (step.action === 'click') {
      await loc.click({ timeout: 5000 });
    } else if (step.action === 'fill') {
      const value = step.field && Object.prototype.hasOwnProperty.call(params, step.field)
        ? params[step.field]
        : step.text;
      await loc.fill(String(value ?? ''), { timeout: 5000 });
    } else if (step.action === 'select') {
      const value = step.field && Object.prototype.hasOwnProperty.call(params, step.field)
        ? params[step.field]
        : step.text;
      await loc.selectOption({ label: String(value ?? '') }, { timeout: 5000 });
    } else {
      return false;
    }
    await page.waitForTimeout(500);
    return true;
  } catch {
    return false;
  }
}

export async function replay(page, recording, params) {
  let i = 0;
  let consecutiveClickSkips = 0;
  while (i < recording.length) {
    const step = recording[i];

    if (step.action === 'wait') {
      await page.waitForTimeout(1000);
      i++;
      continue;
    }
    if (step.action === 'key') {
      await page.keyboard.press(step.key);
      i++;
      continue;
    }
    if (step.action === 'scroll') {
      await page.mouse.wheel(0, step.direction === 'up' ? -400 : 400);
      i++;
      continue;
    }

    if (step.action === 'click' && valueChanged(step, params)) {
      // The requested date/room differs from what was recorded - this exact click would set the WRONG
      // value if replayed verbatim (its locator name literally IS the old value). Don't even attempt it.
      return { broken: true, brokenAtStep: i, page };
    }

    if (!step.role || !step.name) {
      // pixel-fallback - nothing stable to re-locate, regardless of action type.
      return { broken: true, brokenAtStep: i, page };
    }

    await dismissOverlays(page).catch(() => {});

    if (await tryStep(page, step, params)) {
      consecutiveClickSkips = 0;
      i++;
      continue;
    }

    if (step.action === 'click' && consecutiveClickSkips < MAX_CONSECUTIVE_CLICK_SKIPS) {
      consecutiveClickSkips++;
      i++;
      continue;
    }
    return { broken: true, brokenAtStep: i, page };
  }
  return { broken: false, page };
}
