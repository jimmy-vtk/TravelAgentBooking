// A recording is scoped to (hotel, provider/site), not to the provider alone - the client's explicit
// clarification. Plain JSON files on disk; this isn't the same "swappable store" concept as the job
// store (that one has a real reason to swap backends - local dev vs. TakeMeTo's staging Postgres). A
// recording has no such requirement, so the simplest thing that works is the right amount of engineering.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.RECORDINGS_DIR || 'recordings';

function keyFor(hotelName, providerName) {
  return `${hotelName}__${providerName}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function getRecording(hotelName, providerName) {
  const path = join(DIR, `${keyFor(hotelName, providerName)}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

// A recording saved after a partial-replay break is `recording[0..brokenAtStep) + Discover's fresh
// continuation` spliced together (see bookHotel.mjs) - and Discover's own continuation sometimes
// redundantly repeats an action that already worked (a re-click on a link, a re-fill the UI didn't
// visually confirm yet). Left as-is, that redundancy gets saved as part of the "canonical" recording and
// compounds on every future break-and-resume cycle - live-verified 2026-09 on Agoda: one recording ended
// up with the same hotel-name link clicked three times in a row and the same phone field filled five
// times in a row. Collapse consecutive steps that target the same (action, role, name, field) down to
// just the last occurrence - the latest attempt is the one most likely to reflect what actually stuck,
// and for a plain repeated click there's no meaningful difference between occurrences anyway.
function dedupeConsecutive(steps) {
  const out = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    const sameTarget = prev
      && prev.action === step.action
      && prev.role === step.role
      && prev.name === step.name
      && (prev.field ?? null) === (step.field ?? null);
    if (sameTarget) {
      out[out.length - 1] = step;
      continue;
    }
    out.push(step);
  }
  return out;
}

// A one-off mis-click during Discover (the model briefly typing into the wrong element before correcting
// itself a step or two later) isn't caught by dedupeConsecutive - it's not a repeat of anything, just a
// single wrong step - but it's just as fatal to replay: live-verified 2026-09 on Agoda, a recorded step
// was `fill [button "Sign in"] = "Max"`, a genuine mistake the model corrected two steps later by closing
// a sign-in modal and filling the real field - yet replaying that fill against a button element throws
// immediately (Playwright's .fill() requires an editable element), hard-breaking replay right there. A
// `fill`/`select` step targeting a non-editable role is never legitimate regardless of how it got there;
// drop it outright rather than merely deduping it.
const EDITABLE_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton']);
function dropInvalidFillTargets(steps) {
  return steps.filter((step) => {
    if (step.action !== 'fill' && step.action !== 'select') return true;
    return EDITABLE_ROLES.has(step.role);
  });
}

export function saveRecording(hotelName, providerName, steps) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${keyFor(hotelName, providerName)}.json`);
  const cleaned = dedupeConsecutive(dropInvalidFillTargets(steps));
  writeFileSync(path, JSON.stringify(cleaned, null, 2));
  return path;
}
