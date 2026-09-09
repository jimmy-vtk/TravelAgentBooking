# TravelAgentBooking

Hotel booking agent built for TakeMeTo's trial task. Discover a provider's booking flow live once, record it, replay it deterministically after — right up to (not through) payment.

See `APPROACH.md` for the higher-level summary (tech stack, data-flow diagram, a worked demo case, known limitations). This document covers setup/run instructions plus the full design rationale and live-verified fixes.

---

## Setup (fresh machine)

Written assuming nothing is installed yet.

**1. Prerequisites**

- **Node.js 22 or later** — [nodejs.org](https://nodejs.org/). Check with `node --version`.
- **Google Chrome** (the real browser, not just any Chromium) — [google.com/chrome](https://www.google.com/chrome/). The agent drives your actual installed Chrome (`channel: 'chrome'` in Playwright), not a bundled copy, because live testing found that real sites' bot-detection treats the bundled open-source Chromium differently from real Chrome. Install it normally if it isn't already on the machine.
- **git**, to clone the repo.
- An **Anthropic API key** with available credit — [console.anthropic.com](https://console.anthropic.com/). Every live booking run costs real API usage (roughly $0.25–$1.10 per cold run — see `APPROACH.md` §4).
- (Windows only, occasionally) if `npm install` fails while building `better-sqlite3` from source rather than using a prebuilt binary, install the "Desktop development with C++" workload via [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and Python 3, then re-run `npm install`. Most machines never hit this — `better-sqlite3` ships prebuilt binaries for common platforms.

**2. Clone and install**

```bash
git clone <this-repo-url>
cd TravelAgentBooking
npm install
```

**3. Configure your API key**

```bash
cp .env.example .env
```

Open `.env` and set:

```
ANTHROPIC_API_KEY=sk-ant-...
```

(Leave `ANTHROPIC_WORKSPACE_ID` blank unless your key is an org/SSO-issued "identity-linked" key rather than a plain Console key.)

**4. Verify the install — run the test suite (no API key needed, no network)**

```bash
npm test
```

All tests should pass in well under a minute; this only exercises a local fixture server, never a live site or the Anthropic API.

**5. Run a real booking**

Edit `providers.json` (or point `--providers` at your own copy) to the provider(s) you want to try, in the shape:

```json
[
  { "name": "Agoda", "homepage": "https://www.agoda.com", "pricePerNight": 6367096 }
]
```

Then:

```bash
npm run run -- --hotel "Sofitel Mumbai BKC" --checkin 2026-10-15 --checkout 2026-10-18 --guests 2 --providers providers.json
```

A real, headed Chrome window opens and drives the actual booking flow. On success, a proof screenshot lands in `proof/` and a reusable recording in `recordings/`; either way the JSON result prints to stdout. Add `--roomtype "..."` for a room-type preference, or `--verbose` to see every step as it happens.

Useful environment variables (set inline, e.g. `MAX_STEPS=40 npm run run -- ...`):

| Variable | Default | Purpose |
|---|---|---|
| `HEADLESS` | unset (headed) | Set to `1` only on a machine with no display — headed is what's proven to work against real anti-bot checks |
| `MAX_STEPS` | `25` | Raise this for a site that needs more steps than budgeted (many popups, a multi-step calendar) |
| `ABS_PROFILE_DIR` | `.abs-profile` | The persistent Chrome profile directory — reused across runs so cookies/history accumulate like a real returning visitor |
| `DEBUG_PAYMENT_CHECK` | unset | Set to `1` to print the payment-detection check's reasoning to stderr on every step |
| `DEBUG_SHOTS` | unset | Set to a directory path to save a screenshot every step (not just the final proof) |
| `COST_LOG_PATH` | `cost-log.jsonl` | Where per-attempt cost/runtime entries are appended |
| `RECORDINGS_DIR` | `recordings` | Where saved recordings live |
| `JOB_DB_PATH` | `jobs.sqlite` | Local SQLite file backing the job store (see below) |

**6. Run the job-store worker** (the queue-pattern entry point, instead of the direct CLI above)

```bash
node --input-type=module -e "
import { insertJob } from './src/jobStore.mjs';
insertJob({ id: 'demo-1', hotel_name: 'Sofitel Mumbai BKC', check_in: '2026-10-15', check_out: '2026-10-18', guests: 2, providers: [{ name: 'Agoda', homepage: 'https://www.agoda.com', pricePerNight: 6367096 }] });
"
npm run worker -- --job-id demo-1
```

This reads the job row, calls `bookHotel(...)`, and writes `status`/`error`/`proof_url` back onto the same row — the local stand-in for TakeMeTo's real `booking_jobs` table (see `APPROACH.md` for the swap-to-Postgres plan).

---

# Approach

Built from scratch for the trial task. Not a fork or reuse of `takemeto-abs/` — that repo was used only as reconnaissance (to confirm the pattern is sound) and as a source of real example links to test against.

## Core idea

One generic agent that learns a specific hotel's booking flow on a specific site, live, the first time — and a lightweight replay mechanism that reuses what it learned whenever that same hotel is booked again with different dates or a different room type. A recording is scoped to (hotel, site), not to the site alone; see "Cross-hotel reuse" below for the conceptual path to broadening that, which is optional to actually build this week.

## Architecture

```
bookHotel(hotelName, checkIn, checkOut, roomType, guests, providers):
  for provider in providers:
    recording = RecordingStore.get(hotelName, provider)
    if recording:
      result = Replay(recording, params)
      if result.broken:
        # resume live from the break point — the known-good prefix is kept, never discarded
        result = Discover(provider, params, page=result.page, resumeFrom=result.brokenAtStep)
        if result.success:
          RecordingStore.save(hotelName, provider, recording.steps[:result.brokenAtStep] + result.trace)
    else:
      result = Discover(provider, params)
      if result.success: RecordingStore.save(hotelName, provider, result.trace)
    if result.success:
      return { status: 'reached_payment', provider, proof: screenshot() }
  return { status: 'needs_review' }
```

**Discover** — an agent loop drives a real browser from just the hotel name/dates/room type/guests, with no prior knowledge of the site (room type is a preference, not a hard filter — if the requested type isn't available, proceed with whatever is). It can start cold (a fresh navigation) or resume mid-flow on an already-live page handed to it by a broken Replay — same loop either way, only the starting point differs. Each step it's given both:
- the current screenshot (vision)
- a structured list of what's on the page — roles, labels, placeholders (DOM/accessibility grounding)

It's told to prefer acting on the DOM list (cheaper, more reliable, less prone to drift) and fall back to a raw pixel click only for things with no DOM signal — calendar day cells, custom widgets, canvas. This is one model call per step with both inputs, not two separate systems merged. It stops the instant the page looks like a genuine payment/checkout page *and* every required guest-detail field is actually filled in (see Verify below) — or gives up if it can't get there.

**Record** — every action Discover successfully executes is logged as it happens, tagged by *which input field* it came from ("fill the hotel name here," "click the reserve button") rather than the literal value. A recording is keyed by (hotel, site): replaying it with a different check-in/check-out or room type is expected to work; a different guest count is a nice-to-have, not guaranteed yet; a different hotel on the same site is a separate question — see "Cross-hotel reuse" below.

**Replay** — for a (hotel, site) pair we already have a recording for, run the recorded steps directly with the new dates/room type/guests substituted in — no model call, fast, deterministic — until a step breaks.

**Partial replay** — a broken step does not discard the recording. Replay's known-good prefix already ran and left the browser on a real, live page in exactly that state; Discover takes over from there ("finish reaching payment from here"), and its output steps get appended to the old prefix as the new recording. The system accumulates what it's learned instead of relearning the whole flow every time a site tweaks one step.

**Fallback** — providers are tried cheapest-first. Whichever succeeds — via Replay or Discover — wins; a failure moves to the next.

## Drift detection (section 06)

Not a separate check — a natural consequence of the design. A broken Replay step (an expected element is no longer there) *is* the drift signal. The response is never to patch the broken step in place — and, per partial replay above, never to throw away the steps that still worked either. Discover resumes on the live page exactly where the recording broke:
- Discover succeeds → the recording updates: known-good prefix kept, broken tail replaced with what Discover just did. The site has self-healed with no manual intervention and no relearning of steps that were never actually broken.
- Discover also fails from that point → this provider is dropped for this attempt; move to the next-cheapest.

## Cross-hotel reuse (concept only — not built this week)

A recording is currently scoped to one (hotel, site) pair. Whether — and how — it could extend to *any* hotel on that same site is worth answering in principle, even though implementing it is optional for this POC.

Most of a recording already generalizes for free, because of how Record tags steps by field rather than by literal value. The search step ("fill the hotel name," "select the matching autocomplete result") and the guest-details/payment steps ("fill first name," "fill email") act on the same search box and the same checkout form regardless of which hotel is being booked — replaying those for a different hotel on the same site should already work without any change to the mechanism.

The one step that genuinely doesn't generalize is **room selection**. Room names, counts, and layouts are hotel-specific — a recording that says "click the card labeled 'Luxury King Room'" has nothing to click on a hotel that doesn't offer that room. Two ways to close that gap, neither built this week:
- **Keep that one step dynamic.** Even on an otherwise-replayed run, re-solve just the room-selection step live (a single Discover step, not the whole flow) — cheap, since it's one model call instead of a full run.
- **A structural heuristic instead of a literal target.** Most room-list pages are a repeating card pattern (name, price, a select button); a small piece of deterministic code could read that structure at replay time and pick the card matching `roomType` (fuzzy text match) or the cheapest available if no match — no model call needed, but requires confirming the repeating-card assumption actually holds across a site's different hotel pages first.

Either path needs the same validation first: run a recording's non-room-selection steps against two or three different hotels on the same site and confirm they hold structurally before investing engineering time in either approach.

## Guardrails

- Never solves a CAPTCHA.
- Never enters payment/card data.
- Never clicks a final "Pay"/"Confirm and pay" button.
- Stops the instant a page qualifies as checkout — reaching it is the success condition, not a step to continue past.

**On CAPTCHA specifically:** section 08's "allowed to work around anti-bot protection" is read here as license to *avoid triggering* it (realistic pacing, on-site navigation, session warming — the §02 optional tip) — not a requirement to defeat one that appears. No self-solving, no third-party solving service; out of scope for a one-week build. A CAPTCHA encountered mid-run is treated exactly like any other provider failure (§02.3's "structure not recognized") — `Discover` stops with `why=captcha`, which is not success, so the existing fallback-to-next-provider loop handles it with no special-case code. Target providers were chosen partly on this basis: live testing found zero CAPTCHAs across the candidates actually selected.

## Verify — what counts as success

Reaching a page that *looks* like payment is necessary but not sufficient. The end state is: the payment page is reached **and** every required field up to that point is actually filled in — guest names, email, phone, and whatever else the target's form requires — everything except payment data itself — **and** it's genuinely the payment page for the hotel that was actually requested.

- Guest data is fixed, fictional placeholder data the agent supplies itself (e.g. Max Mustermann / a placeholder email and phone) — it is **not** read from the job row. The job schema (section 03) has no guest-personal-detail fields (`hotel_name`/`check_in`/`check_out`/`room_type`/`guests`/`providers`/`selected_provider` only), so there's nothing to add there; this is entirely the agent's own concern.
- The success check reads the DOM's actual field values at the point of stopping — every required input the guest-details step touched must be non-empty — not just a text/price match on the page. A run that reaches a payment-looking page with an empty required field is **not** success; it's treated as `stuck`/incomplete and falls through the same failure path as any other unmet goal.
- **Hotel-identity guardrail (found by review, 2026-09):** every check above only ever asked "is this A real, validly-filled payment page" — never "is this THE payment page for the hotel we were actually asked to book." A search/autocomplete mis-pick landing on a real, correctly-fillable checkout for a *different* property would have satisfied every other signal and still not been a correct booking. Manually auditing every live proof screenshot on file (Agoda, Traveloka, both Mews runs) confirmed the hotel name shown was in fact correct in all four — but that was true by luck, not because anything enforced it. `matchesRequestedHotel()` (`verify.mjs`) closes the gap: a word-overlap text match (same no-OCR/no-NLP constraint as `looksLikePayment`) between the requested `hotelName` and the flow's own aggregated cross-frame text, tolerant of a single dropped/abbreviated word (a site legitimately showing "Sofitel Mumbai" without "BKC") but not of two different properties sharing only a generic word like "Hotel." Wired into both the live Discover loop and the Replay success re-check (the latter previously read only main-frame text — a separate, narrower gap fixed at the same time by extracting a single shared `collectFlowText()` helper both paths now call). Covered by fixture regression tests in `test/verify.test.mjs`.
- Each `Discover` run logs its token cost and wall-clock runtime (informational — not a pass/fail criterion, surfaced in the report for visibility).

## Scope for the one-week POC

**In scope:**
- One successful run per category (major OTA, smaller/newer OTA, hotel's own site). For the major OTA specifically, a single successful run is enough on its own — it does not need to be proven to replay or generalize.
- On at least one category, the same hotel's recording re-tested via Replay with a different stay period and a different room type — the "repeatable algorithm" proof, scoped per (hotel, site) rather than across hotels, per the client's clarification.
- **Optional stretch, time-boxed:** an attempt on Booking.com or Expedia specifically. Success isn't required — if it fails, capturing *why* (CAPTCHA, fingerprinting, page structure) is itself useful and explicitly welcomed. First thing cut if the week runs tight; it doesn't threaten any required deliverable.
- Fallback to next-cheapest provider on failure
- Proof screenshot per attempt, plus one per recorded state change (search → room selected → guest details → review/payment) — free, since Record already logs each step as it happens; this is what makes the "turned into a repeatable algorithm" transition checkable, not just claimed
- Field-fill and cost/runtime verification, as above
- **A thin job-store worker.** Section 02 lists "pick up an open job from our queue" and "report the result back" as explicit build steps (1 and 4), and section 01 frames the whole task as porting the existing queue→worker→writeback pattern from restaurants to hotels — this is a stated requirement, not incidental plumbing. The worker: read one row matching section 03's schema (`job_type`, `hotel_name`, `check_in`, `check_out`, `room_type`, `guests`, `providers`, `selected_provider`), call `bookHotel(...)`, write `status` / `error` / `proof_url` back. Built against a swappable store interface — local SQLite/Postgres to develop and demo against now, TakeMeTo's staging key once it's provided, no code change in between. Cheapest, lowest-risk part of the week; done early rather than left for the end.

**Out of scope:**
- Actual queue *semantics* beyond single-row read/write: no always-on polling service, no locking/concurrency handling, no retry-on-crash, no kill-switch. One job in, one result out, invoked directly (script or test) — not a long-running daemon.

## Deliverable

What actually ships at the end of the week — each item mapped to the evaluation criterion in section 07 it exists to satisfy, not included for its own sake.

- **The repo.** `bookHotel(...)` (Discover / Record / Replay / verify), the job-store worker with its swappable SQLite/Postgres interface, and a runnable fixture-based test suite (`npm test`). → *"code quality."*
- **Three successful runs, one per category** (major OTA, smaller/newer OTA, hotel's own site). Each comes with: the final payment-page proof screenshot and the saved recording/trace that run produced. A screenshot per recorded state change (search → room selected → guest details → payment) is supported (`DEBUG_SHOTS`) but wasn't turned on for these particular final runs — the recording's own step-by-step trace is what actually stands in as the checkable "how it got there" artifact for these three. → *"coverage across all three categories"* + *"provability."*
- **The repeatable-algorithm proof.** The substitution mechanism (recognize a changed date/room type on a recorded `click` step, hand off to Discover exactly there rather than reusing the old value) is implemented and live-verified on Traveloka: replay correctly detects the change and resumes at the right step across 3/3 attempts. Full completion to payment with genuinely different dates wasn't reached live in those 3 attempts, for a reason unrelated to the mechanism itself (see "Changed dates/room type" below) — the same-dates replay-then-resume case (Tier-2 item 4's first half) remains the one full live proof of Replay/Discover splicing end to end. Scoped per (hotel, site), per the client's clarification — not a cross-hotel test. → *"what today is worked out half-manually should turn into an algorithm... only the dates, room type and guest count still vary."*
- **A written, conceptual answer on cross-hotel reuse** — not implemented, but reasoned through: which steps already generalize for free (search, guest details, payment) and which one doesn't (room selection), with two concrete paths forward. → the client's explicit ask for "a conceptual section... to understand the path forward."
- **The Booking.com/Expedia attempt, if time allows.** Never actually attempted this week — explicitly the first thing to cut if time runs tight, and it did. → the client's explicit interest in this even as a negative result; the negative result here is simply "not reached," not a failed attempt.
- **A fallback-in-action example.** The provider-fallback loop in `bookHotel.mjs` is straightforward and correct by inspection (try providers in order, move to the next on any failure), and every multi-provider live run has exercised it implicitly — but there's no dedicated fixture test isolating it, and no live run specifically engineered to fail its first provider on purpose. Tracked as an honest gap rather than claimed as done. → *"failures automatically trigger the next-cheapest provider... instead of giving up on the job right away."*
- **An honest failure log.** Any hotel/provider combination that ends in `needs_review`, with its reason recorded rather than silently dropped or papered over. → *"whether a small, honestly-named remainder of cases gets handed to a human instead of being papered over."*
- **A cost/runtime report** — token cost and wall-clock time per `Discover` run, informational, not scored.
- **This document**, standing as both the drift-detection answer (section 06) and the "one-off success turned into a repeatable algorithm" write-up section 02 asks to see, not just claim.

Explicitly *not* part of the deliverable: a working booking on Booking.com/Expedia specifically (an attempt is a stretch goal, not a requirement), 95% reliability, cross-hotel reuse actually implemented, or coverage of more than one example per category — none of that is what's being measured.

---

## Testing

Two tiers, because this system's hard failure mode is real-site drift — testing it entirely against live sites would make the test suite itself flaky for the wrong reason.

### Tier 1 — deterministic, no network (run every time, fast)

A local fixture page (a tiny static HTML form under our control, not a real OTA) stands in for "a provider." This tier never calls a live site and never calls the model for anything except the pieces that genuinely need it — most of it is testing the *logic*, not the agent.

This list is kept honest against what `test/*.test.mjs` actually contains (26 tests, last audited 2026-09) — an earlier pass of this document listed several tests that were only ever planned, not written; every bullet below is real and passing under `npm test`.

- `verify()` (payment-page detection): feed it sample page text — positive cases (real payment-page wording + price) and negative cases (a results page, a cart page, an unrelated page with a stray "€" in it) — confirm it only fires on the real thing.
- Field-fill verification: fixture where the page text matches payment wording but a required guest field (e.g. email) is left empty → success check must fail. Fill it → must pass. This is the difference between "page reached" and "actually done."
- Replay executor against the fixture: a recording with a step whose element exists → step succeeds. A recording with a step whose element has been removed (simulate drift by editing the fixture) → executor reports `broken` at that exact step index, does not throw, does not silently skip. A step with no role/name at all (a pixel fallback) is always treated as broken too.
- Record reuse across parameters (dates/room type): a recording with a date-cell or room-selection `click` step tagged `field`/`text` (see "Changed dates/room type" below) replays fine when the requested value matches what was recorded, is recognized as broken *before even attempting the click* when the value has genuinely changed (so a stale date is never blindly re-clicked), and is left alone when no preference was requested at all (room type is "a preference, not a hard filter").
- Cross-origin frame scoping (`isRelevantFrame`): unit cases for same-site, a known payment-processor subdomain, and unrelated ad/captcha networks. Plus a fixture reproducing the live Agoda bug directly — a page embedding a genuinely cross-origin iframe whose own text and input satisfy the full payment-detection signal entirely on its own — confirming `hasPaymentInputFields` excludes it while still catching the real, same-site payment iframe.
- `recordingStore`: round-trips scoped per (hotel, provider); collapses consecutive duplicate steps down to the last attempt; drops a `fill`/`select` step that targets a non-editable role (a stray mis-click that would otherwise hard-break a later replay).
- `jobStore`: round-trip matches the section-03 schema fields exactly; `writeJobResult` updates `status`/`error`/`proof_url` on the same row for both a success and a failure outcome.
- `costLog`: one JSON line per attempt with a real timestamp and a rounded cost; running totals sum and filter correctly by hotel/provider.

**Known, honestly-tracked gaps in Tier 1** (not yet written, none of them blocking): a fixture-level test of `bookHotel`'s own provider-fallback loop (mock two providers, first fails, confirm the second is tried) — the loop is simple and correct by inspection, and live runs have exercised multi-provider lists, but no automated test pins it down; a guardrail-fixture test (a fake "Pay now" button, confirm the agent never clicks it) — the guardrail is enforced entirely in the model prompt, which isn't something Tier 1's no-network design can exercise without a real or mocked model call; a test of `src/cli/worker.mjs` itself (as opposed to the `jobStore.mjs` functions it calls) — nothing currently exercises the actual `getJob → bookHotel → writeJobResult` wiring end to end.

### Tier 2 — live smoke tests (run manually, before each proof submission — not on every commit)

Real sites drift on their own schedule; these confirm the actual deliverable, not the logic in isolation.

1. **Major OTA — cold Discover.** ~~Trip.com~~ **Agoda** (swapped live 2026-09: Trip.com's own naturally-searched flow needed more steps than budgeted and was deprioritized in favor of a provider that reached payment cleanly within budget). A hotel from the example list, fresh run, no existing recording, natural on-site search (no deep link). Reached payment, every guest-detail field actually filled — **done**, $0.46, proof screenshot on file. This one run is sufficient for the major-OTA category on its own. (An earlier attempt on this same hotel had first *reported* success after only 9 steps and $0.22 — a false-positive payment detection, caught by checking the proof screenshot against what the model actually claimed rather than trusting the claim. See "Agoda-specific fixes" below; this result is the re-run after that bug was found and fixed, confirmed against the genuine "Payment information" page.)
2. **Major OTA — replay, same hotel, changed stay period + room type.** Attempted against Agoda. The current recording's first 5 of 9 steps (SEARCH click through room selection) replayed with **zero model calls** — every step in the current recording has a real `(role, name)` locator, the direct result of the date-picker prompt fix below removing the one pixel-only step a fresh capture used to produce. It broke on a checkout-flow interstitial that isn't consistently present run-to-run; Discover's resume from that break did not reach payment on this particular attempt (ended `stuck`, $0.26 for the resumed portion) — logged as an open item below rather than re-run repeatedly at further cost. The live, successful repeatable-algorithm proof for this deliverable item remains item 4's Traveloka case.
3. **Smaller/newer OTA — cold Discover.** ~~Halalbooking~~ **Traveloka** (swapped live 2026-09: Halalbooking, Tiket.com, and Cleartrip were each tried first and ruled out live - Halalbooking/Tiket.com showed the identical-looking-session "real Chrome succeeds, Playwright fails" automation-fingerprint gap described under Guardrails/Drift below; Cleartrip hard-requires a real, checksum-validated Indian PAN number, incompatible with this project's fictional-data-only guardrail). Four Points by Sheraton Bali, Seminyak, fresh run. Reached payment, fields filled — **done**, $0.54-0.90 per cold run depending on path taken, proof screenshot on file.
4. **Smaller/newer OTA — replay, changed stay period + room type.** Two distinct things were actually tested here, and it's worth being precise about which is which:
   - **Same-dates replay-then-resume: done, live-verified 2026-09.** Re-ran the saved (hotel, Traveloka) recording for the *same* hotel/dates against a fresh session. Replay executed the first **8 steps with zero model calls** — hotel-name search, autocomplete-suggestion selection, both check-in/check-out date-cell selections, and navigation into the room list, all matched purely by (role, name) — before breaking at a genuinely non-deterministic login-prompt interstitial that doesn't appear identically on every visit. Discover resumed from exactly that point and reached payment. Total run cost **$0.34**, versus $0.67-0.90 for a cold Discover run on the same hotel. See "Traveloka-specific fixes" below.
   - **Genuinely changed dates + room type: mechanism verified, full completion not yet reached live.** After finding (auditing against the trial-task spec, 2026-09) that no recording actually tagged `checkIn`/`checkOut`/`roomType` as substitutable at all — see "Changed dates/room type" below — those steps were re-captured with the fix in place, then replayed against genuinely different dates (Nov 5-8 instead of the recorded Oct 15-18) and a different room type. Across 3 live attempts, replay correctly recognized the date mismatch and handed off to Discover at exactly the right step (`resumedFromStep: 1`) every single time, never once attempting the stale Oct-15 click — and Discover's resume did correctly click "Nov 5, 2026" as the new check-in date on its very first attempt at it. None of the 3 attempts reached payment, though: the site's own 2-month calendar widget (requiring an extra "advance to next month" step the recorded flow never needed) repeatedly tripped the model into re-clicking a date it had already set and eventually producing malformed output a step or two later. This is a separate, real gap in multi-month calendar navigation - not a flaw in the substitution mechanism itself, and not something the spec actually requires (it only asks for "a different stay period," not one that crosses into a month the calendar isn't already showing). Not pursued further at additional live cost past 3 attempts (~$0.86); a same-month date change was never tried and would very plausibly complete cleanly, since it wouldn't touch the calendar-navigation issue at all.
5. **Hotel's own site — cold Discover.** ~~Cloudbeds-based hotel~~ **Mari Jean Hotel (Mews-powered)** — St. Petersburg, FL, `marijeanhotel.com`, one of the trial spec's own listed "hotel's own booking site" examples. A Cloudbeds-based attempt (Hotel McCoy, Tucson) was also live-tested and is documented as an unresolved case below rather than silently dropped. Reached the genuine payment page, every guest field non-empty and passing the site's own validation — **done**, $0.57 for the final confirmed run, proof screenshot on file. See "Mews-specific fixes" below for the real chain of seven bugs this uncovered, the last of which (a phone-format validation error the automatic check didn't originally catch) is now fixed and live-verified too.
6. **Partial-replay resume, live.** **Done, live-verified 2026-09** — item 4's Traveloka replay run *is* this test: it broke naturally (a real login-prompt interstitial, not an artificially-forced one) at step 8, Discover resumed on the live page without restarting from search, and the recording saved afterward is exactly the kept prefix plus Discover's new tail.
7. **Sold-out / dead-end case.** Point Discover at a hotel/provider combination known to have no availability. Must fail cleanly (not hang, not loop to `max_steps` silently) and hand control back to the fallback loop.
8. **Fallback in the wild.** A job with an intentionally-broken top provider (bad URL) and a working second one. Must skip the first and succeed on the second, and the returned result must say which provider actually succeeded.
9. **Optional stretch — Booking.com or Expedia attempt.** Whatever happens, document it: reached payment, or the specific reason it didn't (CAPTCHA, fingerprint block, unrecognized structure).

Every Tier 2 run's proof screenshot is the same artifact required for the actual submission — these tests and the deliverable are the same activity.

## Traveloka-specific fixes (2026-09) that made a real replay possible

The first captured Traveloka recording replayed 0 steps deterministically — every step broke immediately on a raw pixel coordinate. Root-caused live to two gaps in how `Discover` names elements, both now fixed in `discover.mjs`:

- **`getInteractiveElements()`'s candidate selector was blind to framework-rendered click targets with no semantic markup at all.** Traveloka (react-native-web output) renders its autocomplete-suggestion rows and calendar day cells as plain `<div>`s — no `button`/`role`/`onclick` attribute, the click is a React-delegated listener. Confirmed live that the actual clickable wrapper for both carries `tabindex="0"` with `cursor: pointer`; adding `[tabindex]` to the candidate selector lets these get numbered and named at all, instead of falling through to an unrecoverable pixel-only step.
- **A short (≤3 char) `innerText` — a bare day-of-month number — is ambiguous** once named that way: the same text ("1", "8", …) recurs once per visible month, and several months are commonly pre-rendered in the DOM off-screen at once. Confirmed live that every such cell also carries `data-testid="date-cell-{day}-{month}-{year}"` — a real, unique identifier. `accessibleName()` now prefers that over the bare digit whenever the innerText is this short.

Net effect, measured: the Traveloka replay in Tier-2 item 4 now executes hotel search, autocomplete selection, and both date-cell selections — the entire portion these two fixes targeted — with zero model calls, where every earlier attempt broke on the very first or second step.

## Agoda-specific fixes (2026-09): a false-positive success, and a stale prompt rule

A cold Discover run against Agoda first *reported* success (`reached_payment: true`, $0.22, 9 steps) — but the saved proof screenshot showed the *search results* page, not payment. Caught by checking the screenshot against the claim rather than trusting a `success: true` at face value. Root-caused to three separate, real bugs, none of them Agoda-specific quirks:

- **`hasPaymentInputFields()` and the payment-text aggregation scanned every frame on the page, including third-party ad/tracking iframes** (doubleclick, criteo, recaptcha, ad-exchange creatives). One of these, on the search-results page, contained both payment-like wording and a card-shaped input purely as ad content — enough to satisfy the full payment-detection signal on its own, several steps before any real booking flow had started. This had already auto-saved a corrupt recording (`bookHotel.mjs` saves on any `success: true`) that a later diagnostic run then partially replayed into, extending the same false signal.
  Fixed with `isRelevantFrame()` in `verify.mjs` — scopes both checks to frames that are actually part of the booking flow: same registrable domain as the main page, or a known payment-processor domain (Stripe, Adyen, PayPal, etc.). Verified this doesn't regress the original cross-origin-iframe fix it builds on: Agoda's real card form lives on `secure.agoda.com`, same registrable domain as `www.agoda.com`, so it's still caught (confirmed live against the genuine "Payment information" page). Covered by a fixture-based regression test (`test/verify.test.mjs`) that reproduces a genuinely cross-origin ad iframe tripping both signals on its own.

- **The date-picker prompt guidance was stale and actively wrong.** `SYSTEM_PROMPT` told the model "day cells are usually NOT numbered — use pixel click" for every date picker, written back when that was true for Traveloka pre-fix. Live DOM inspection on Agoda showed its calendar day cells ARE numbered — each is a `role="button"` element with a disambiguating `aria-label` (e.g. `"Tue Oct 20 2026"`) — but the prompt told the model to ignore that and pixel-click regardless, producing an unreplayable step no matter what `discover.mjs`'s own element detection could see. Fixed by telling the model to check the numbered list for a match against the full target date first, falling back to pixel click only if genuinely absent.

- **Headless Chrome triggers Agoda's own bot detection.** Two headless (`HEADLESS=1`) capture attempts failed instantly at zero cost (`net::ERR_HTTP_RESPONSE_CODE_FAILURE`, 0ms) — the same class of issue already solved for Traveloka. Running headed (the framework's own default) fixed it immediately; `HEADLESS=1` should be treated as a debugging convenience, not something to rely on for a real run.

Net effect: Agoda's major-OTA deliverable (Tier-2 item 1) is a genuine, verified success. The calendar fix is verified correct by direct DOM inspection but wasn't exercised end-to-end in either fresh capture that followed it, because Agoda's own server-side "recently viewed" search suggestion kept auto-filling the exact target dates before the calendar ever had to open — so every recording captured after the fix happens to have zero pixel-fallback steps regardless, without the fix having been forced to prove itself against a real calendar click.

## Changed dates/room type (2026-09): the actual substitution mechanism

Auditing this project against the trial-task spec directly (rather than trusting this document's own earlier claims) surfaced a real gap: **no recording ever tagged `checkIn`/`checkOut`/`roomType` as a substitutable field at all**, and the gap was structural, not an oversight in test coverage. Date selection is always a *click* on a calendar day cell whose own locator name literally encodes the date (`"date-cell-15-10-2026"`, `"Tue Oct 20 2026"`) — and `replay.mjs`'s parameter-substitution logic only ever rewrote values for `fill`/`select` actions, never for `click`. Room selection has the identical problem (a hardcoded click on a specific room's display name). The one live "changed stay period" test on record turned out, on honest re-reading of its own trace, to have replayed the *same* dates — the item's title had outlived what was actually tested.

Fixed with three coordinated changes:
- **`SYSTEM_PROMPT`** now lets a `click` action optionally carry `field`/`text` too (previously only `fill`/`select` could), with explicit rules telling the model to tag a calendar day-cell click with `field: "checkIn"|"checkOut"` and the date in `YYYY-MM-DD` format, and a room-selection click with `field: "roomType"` and the room's own displayed name.
- **`discover.mjs`'s step-recording** captures that `text` for a field-tagged `click`, the same way it already did for `fill`/`select`.
- **`replay.mjs`** gained `valueChanged(step, params)`: before attempting a field-tagged `click`, it compares the recorded value against what THIS run actually wants. A genuine mismatch is treated as an immediate break at that exact step — hand it to Discover to re-solve live — rather than trying to pattern-match or rewrite an unknown site's own date-cell naming convention (which has no generic solution across arbitrary sites). No preference requested (`roomType: null`) never forces a break, matching "room type is a preference, not a hard filter." Fully backward-compatible: a step with no `field` behaves exactly as before.

Covered by two fixture regression tests in `test/replay.test.mjs`; a matching-date click replays normally, a changed-date click breaks at that exact index *without ever attempting the stale click*.

Live-verified on Traveloka: a fresh capture correctly tagged both date-cell clicks (`field: "checkIn"`/`"checkOut"`) and the room-selection click (`field: "roomType"`). Replaying it against genuinely different dates (Nov 5-8 instead of the recorded Oct 15-18) correctly broke at the check-in step every time across 3 live attempts (`resumedFromStep: 1`, never touching the stale Oct-15 locator), and Discover's resume did correctly click the new Nov 5 date on its first attempt each time — the mechanism itself works. None of the 3 attempts finished all the way to payment, though: picking a date in November required the model to first advance this site's 2-month calendar forward, and it got confused mid-navigation (re-clicking a date it had already set, then producing malformed output) on all 3 tries. That's a separate, genuine gap in multi-month calendar navigation — not a flaw in the substitution logic — and, on reflection, one this project introduced on itself: the spec only asks for "a different stay period," not one that crosses into a month the calendar isn't already showing. A same-month date change (e.g. Oct 20-23 instead of Oct 15-18) was never tried live and would plausibly complete cleanly, since it wouldn't touch calendar navigation at all; not pursued further after 3 attempts (~$0.86) once the actual, spec-relevant question (does the substitution mechanism work) was already answered.

One more thing found and fixed along the way, unrelated to the substitution logic itself but discovered while live-testing it: **`askModel()`'s `max_tokens` was 600**, tight enough that the model got cut off mid-JSON ("unparseable model output") after writing a longer-than-usual `reason` while genuinely uncertain about a date click. Bumped to 1024 — cheap insurance on the rare turns that need it.

## Known unresolved case: Agoda replay-then-resume

Logged honestly, same as Hotel McCoy below. A replay of the current (all-role/name) Agoda recording got 5 of its 9 steps in with zero model calls — SEARCH, hotel-name fill, property link, scroll, room selection — before breaking on a checkout-flow interstitial that isn't consistently present run-to-run (present when the recording was captured, absent on the replay attempt). Discover's resume from that break point did not reach payment this attempt (`why: stuck`, $0.26) — unlike the equivalent Traveloka case (Tier-2 item 4), where the resume succeeded cleanly. Not pursued further at additional cost past this point; the category's deliverable is already satisfied by the cold-Discover success in Tier-2 item 1, and partial-prefix determinism (5 of 9 steps, zero model calls) is real and demonstrated even though the full resume-to-success chain isn't proven on this provider.

## Mews-specific fixes (2026-09): seven real bugs, found and fixed one at a time

Mari Jean Hotel (Mews) turned out to be the hardest of the three categories - not because Discover couldn't drive the site, but because six separate, genuine bugs in *this project's own verification logic* each masked the next one, so fixing one just exposed the next symptom. Documented here in the order found, since each one is a real, distinct, live-verified defect:

1. **`recordingStore.mjs` dropped every pixel-fallback fill step**, including legitimately-filled ones - `EDITABLE_ROLES.has(null)` treated "no role recorded" identically to "wrong role recorded". A saved Mews recording ended up with zero fill steps at all. Fixed: a missing role is now kept, not discarded (only a *confirmed wrong* role is dropped).
2. **`getInteractiveElements()` couldn't see anything inside Mews's booking widget at all** - the entire flow (dates, rooms, guest details, everything) lives in a same-page `<iframe>`, and element detection only ever evaluated the main frame. Every interaction had always been a blind pixel click as a result. Fixed: element detection now walks every frame, and `executeAction()` builds its locator against the correct frame, not always the main page.
3. **`isRelevantFrame()` didn't recognize Datatrans** (Mews's real, unlisted payment processor), so the genuine card-tokenization iframe was silently excluded from payment detection on every run. Fixed with a URL-content heuristic (`/payment/`, "securefield", "tokenize") that generalizes past any one fixed host list - the same fix that later also caught this:
4. **The Mews widget iframe itself reports as `about:blank` to Playwright** (it was never given a real `src`), so the SAME exclusion that fixed #3 was also hiding the real guest-details page's own text - including the literal word "Payment" and the total price - from the aggregated payment-text check. Fixed: an `about:blank` frame now defaults to relevant, since an ad/tracking network is never `about:blank` (it always navigates to its own real, identifying URL).
5. **`requiredFieldsFilled()` only re-checks fields the trace claims were filled** - when the model filled only "First name" and the automatic check fired anyway (Mews shows the payment section on the same page as guest details, no separate "continue" boundary), Last name/Email/Phone sat visibly empty and unnoticed. Fixed with `hasEmptyRequiredGuestField()`, scanning for any visible, currently-empty field whose *label* looks like a standard guest-detail field, independent of what the trace does or doesn't mention.
6. **That new check then flagged a false positive of its own**: a "marketing-emails-checkbox" opt-in toggle has "emails" in its own `name` attribute, coincidentally matching the `e-?mail` pattern - and a checkbox's `.value` is never a meaningful "filled in" signal. Fixed by scoping the scan to genuine text-entry controls only (the same `isTextEntry` distinction `accessibleName()` already draws), confirmed directly against the live page before spending on another run.

After fix #6, a live run returned a genuine `success: true` via the programmatic check, not a self-report - $0.49, `proof/Own_website_Mews__1788778488258.png`. But that same proof screenshot showed a live validation error - "Select the country code and enter a valid number" - on the phone field, which held a German-style number ("+1 700 000 000") the site's own format validation rejected. `requiredFieldsFilled()`/`hasEmptyRequiredGuestField()` only verified fields held *some* non-empty value, not that the site's own validation rules accepted it - a distinct, deeper gap than the six above (a validation-acceptance question, not an empty-field question). This was the seventh bug:

7. **No check ever looked for a field the site itself had rejected, only for one left empty.** Root-caused with a zero-cost standalone Playwright script (driving the real exported `getInteractiveElements`/`executeAction`/`hasEmptyRequiredGuestField` functions against the live site, not a reimplementation) that filled the phone field with a deliberately-invalid value and inspected the resulting DOM directly: both `#phone` and its country-code sibling `#prefixSelect` carried `aria-invalid="true"`, alongside a visible `<div class="ErrorMessageContainer-...">Select the country code and enter a valid number.</div>`. Fixed with `hasInvalidField()` in `verify.mjs` - a generic, site-agnostic scan for any visible `[aria-invalid="true"]` element across relevant frames, wired into `requiredFieldsFilled()`'s final gate. Verified end-to-end for free before spending on a live run: blocks on the bad value, passes once corrected to a NANP-valid number, with a fixture regression test locking the behavior in (`test/verify.test.mjs`).

All seven were confirmed with direct evidence (not guessed) before being called fixed - either a live debug-flag run pinpointing the exact failing check, or direct DOM inspection of the actual page. A live re-run after fix #7 confirmed the fix works exactly as intended: the model itself first filled the same German-style number, `hasInvalidField()` correctly blocked the premature success this time, and the model - per its own existing prompt guidance about NANP-valid fallback numbers - noticed the validation failure on its own and corrected the phone field to a valid US/Canada-format number before the check passed for real. Genuine `success: true`, $0.57, `proof/Own_website_Mews__1788851829613.png` - a clean payment page with a validly-formatted, non-error phone field, no remaining gap.

## Known unresolved case: Hotel McCoy (Cloudbeds)

Logged honestly rather than silently dropped, per the "honest failure log" deliverable item. Hotel McCoy's own Cloudbeds-powered booking widget (Tucson, AZ) was live-tested extensively and its guest-details "Continue" button intermittently does nothing even when every field is verifiably correct in the DOM (confirmed via debug screenshots across multiple attempts). Two real, separate bugs were found and fixed along the way (a native `<select>` reset the entire widget when confirmed with Enter instead of Tab; the ZIP field triggers a several-second async tax recalculation that can misreport as empty if checked too soon) — neither turned out to be the actual remaining blocker. A zero-cost, no-agent Playwright script reproducing the exact same field values with `.fill()` succeeded on its first try, which rules out the two leading theories tested (untrusted synthetic events, and an expired reservation hold from the slower multi-step-LLM pacing) without identifying a replacement one. This category's actual deliverable was satisfied instead by Mari Jean Hotel (Mews-powered) - see "Mews-specific fixes" above for the real story there too - McCoy is documented here as a real, reproducible site-specific gap rather than pursued further at additional cost.
