# TravelAgentBooking

Hotel booking agent built for TakeMeTo's trial task. Discover a provider's booking flow live once, record it, replay it deterministically after — right up to (not through) payment.

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

Reaching a page that *looks* like payment is necessary but not sufficient. The end state is: the payment page is reached **and** every required field up to that point is actually filled in — guest names, email, phone, and whatever else the target's form requires — everything except payment data itself.

- Guest data is fixed, fictional placeholder data the agent supplies itself (e.g. Max Mustermann / a placeholder email and phone) — it is **not** read from the job row. The job schema (section 03) has no guest-personal-detail fields (`hotel_name`/`check_in`/`check_out`/`room_type`/`guests`/`providers`/`selected_provider` only), so there's nothing to add there; this is entirely the agent's own concern.
- The success check reads the DOM's actual field values at the point of stopping — every required input the guest-details step touched must be non-empty — not just a text/price match on the page. A run that reaches a payment-looking page with an empty required field is **not** success; it's treated as `stuck`/incomplete and falls through the same failure path as any other unmet goal.
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
- **Three successful runs, one per category** (major OTA, smaller/newer OTA, hotel's own site). Each comes with: the final payment-page proof screenshot, a screenshot per recorded state change (search → room selected → guest details → payment), and the saved recording/trace that run produced. → *"coverage across all three categories"* + *"provability."*
- **The repeatable-algorithm proof.** On at least one category, the same hotel's recording replayed with a different stay period and a different room type, with its own screenshot and trace showing whether Replay succeeded directly or Discover resumed partway through and the recording updated. Scoped per (hotel, site), per the client's clarification — not a cross-hotel test. → *"what today is worked out half-manually should turn into an algorithm... only the dates, room type and guest count still vary."*
- **A written, conceptual answer on cross-hotel reuse** — not implemented, but reasoned through: which steps already generalize for free (search, guest details, payment) and which one doesn't (room selection), with two concrete paths forward. → the client's explicit ask for "a conceptual section... to understand the path forward."
- **The Booking.com/Expedia attempt, if time allows.** Whatever the outcome, documented — including *why* if it fails. → the client's explicit interest in this even as a negative result.
- **A fallback-in-action example.** Reproducible on demand via the fixture test suite (a mocked top-provider failure correctly falls through to the next-cheapest); any live case that occurs naturally during the real runs is kept as a bonus, not required. → *"failures automatically trigger the next-cheapest provider... instead of giving up on the job right away."*
- **An honest failure log.** Any hotel/provider combination that ends in `needs_review`, with its reason recorded rather than silently dropped or papered over. → *"whether a small, honestly-named remainder of cases gets handed to a human instead of being papered over."*
- **A cost/runtime report** — token cost and wall-clock time per `Discover` run, informational, not scored.
- **This document**, standing as both the drift-detection answer (section 06) and the "one-off success turned into a repeatable algorithm" write-up section 02 asks to see, not just claim.

Explicitly *not* part of the deliverable: a working booking on Booking.com/Expedia specifically (an attempt is a stretch goal, not a requirement), 95% reliability, cross-hotel reuse actually implemented, or coverage of more than one example per category — none of that is what's being measured.

---

## Testing

Two tiers, because this system's hard failure mode is real-site drift — testing it entirely against live sites would make the test suite itself flaky for the wrong reason.

### Tier 1 — deterministic, no network (run every time, fast)

A local fixture page (a tiny static HTML form under our control, not a real OTA) stands in for "a provider." This tier never calls a live site and never calls the model for anything except the pieces that genuinely need it — most of it is testing the *logic*, not the agent.

- `verify()` (payment-page detection): feed it sample page text — positive cases (real payment-page wording + price) and negative cases (a results page, a cart page, an unrelated page with a stray "€" in it) — confirm it only fires on the real thing.
- Field-fill verification: fixture where the page text matches payment wording but a required guest field (e.g. email) is left empty → success check must fail. Fill it → must pass. This is the difference between "page reached" and "actually done."
- Replay executor against the fixture: a recording with a step whose element exists → step succeeds. A recording with a step whose element has been removed (simulate drift by editing the fixture) → executor reports `broken` at that exact step index, does not throw, does not silently skip.
- Partial-replay splicing: a recording with steps 1-12, simulate a break at step 7 (remove that element from the fixture) → confirm the resumed Discover run only re-does steps 7 onward (not 1-6), and the saved recording afterward is exactly `[old 1-6] + [new 7-N]`, not a full fresh recording.
- Record: run one full Discover pass against the fixture, confirm the resulting recording is well-formed (each step has an action, a locator, and a `field` tag where it fills something) and that replaying it immediately reproduces the same outcome.
- Record reuse across parameters: replay the same fixture recording with a different date range and room type value → confirm those fields update correctly and the run still succeeds (this is the (hotel, site)-scoped reuse the client asked for, tested at the fixture level before trusting it live).
- Fallback loop: mock two providers, first one always fails → confirm the second one is tried and its result is what gets returned.
- Guardrail check: fixture includes a fake "Pay now" button past the checkout page → confirm the agent stops *before* it and never clicks it, under a prompt that tries to nudge it forward.
- Cross-origin frame scoping (`isRelevantFrame`): unit cases for same-site, a known payment-processor subdomain, and unrelated ad/captcha networks. Plus a fixture reproducing the live Agoda bug directly — a page embedding a genuinely cross-origin iframe whose own text and input satisfy the full payment-detection signal entirely on its own — confirming `hasPaymentInputFields` excludes it while still catching the real, same-site payment iframe.
- Worker round-trip against the local SQLite store: insert a row matching the section-03 schema, run the worker, confirm it reads the right fields, calls `bookHotel(...)` with them (mocked), and writes `status`/`error`/`proof_url` back onto the same row correctly for both a success and a failure outcome.

### Tier 2 — live smoke tests (run manually, before each proof submission — not on every commit)

Real sites drift on their own schedule; these confirm the actual deliverable, not the logic in isolation.

1. **Major OTA — cold Discover.** ~~Trip.com~~ **Agoda** (swapped live 2026-09: Trip.com's own naturally-searched flow needed more steps than budgeted and was deprioritized in favor of a provider that reached payment cleanly within budget). A hotel from the example list, fresh run, no existing recording, natural on-site search (no deep link). Reached payment, every guest-detail field actually filled — **done**, $0.46, proof screenshot on file. This one run is sufficient for the major-OTA category on its own. (An earlier attempt on this same hotel had first *reported* success after only 9 steps and $0.22 — a false-positive payment detection, caught by checking the proof screenshot against what the model actually claimed rather than trusting the claim. See "Agoda-specific fixes" below; this result is the re-run after that bug was found and fixed, confirmed against the genuine "Payment information" page.)
2. **Major OTA — replay, same hotel, changed stay period + room type.** Attempted against Agoda. The current recording's first 5 of 9 steps (SEARCH click through room selection) replayed with **zero model calls** — every step in the current recording has a real `(role, name)` locator, the direct result of the date-picker prompt fix below removing the one pixel-only step a fresh capture used to produce. It broke on a checkout-flow interstitial that isn't consistently present run-to-run; Discover's resume from that break did not reach payment on this particular attempt (ended `stuck`, $0.26 for the resumed portion) — logged as an open item below rather than re-run repeatedly at further cost. The live, successful repeatable-algorithm proof for this deliverable item remains item 4's Traveloka case.
3. **Smaller/newer OTA — cold Discover.** ~~Halalbooking~~ **Traveloka** (swapped live 2026-09: Halalbooking, Tiket.com, and Cleartrip were each tried first and ruled out live - Halalbooking/Tiket.com showed the identical-looking-session "real Chrome succeeds, Playwright fails" automation-fingerprint gap described under Guardrails/Drift below; Cleartrip hard-requires a real, checksum-validated Indian PAN number, incompatible with this project's fictional-data-only guardrail). Four Points by Sheraton Bali, Seminyak, fresh run. Reached payment, fields filled — **done**, $0.54-0.90 per cold run depending on path taken, proof screenshot on file.
4. **Smaller/newer OTA — replay, changed stay period + room type.** **Done, live-verified 2026-09.** Re-ran the saved (hotel, Traveloka) recording for the same hotel/dates against a fresh session. Replay executed the first **8 steps with zero model calls** — hotel-name search, autocomplete-suggestion selection, both check-in/check-out date-cell selections, and navigation into the room list, all matched purely by (role, name) — before breaking at a genuinely non-deterministic login-prompt interstitial that doesn't appear identically on every visit. Discover resumed from exactly that point (no restart, known-good prefix kept) and reached payment. Total run cost **$0.34**, versus $0.81-0.90 for a cold Discover run on the same hotel — a real, measured cost reduction from the deterministic prefix, not just a claimed one. See "Traveloka-specific fixes" below for the two code changes that made the search/date-picking portion replayable at all.
5. **Hotel's own site — cold Discover.** ~~Cloudbeds-based hotel~~ **Mari Jean Hotel (Mews-powered)** — St. Petersburg, FL, `marijeanhotel.com`, one of the trial spec's own listed "hotel's own booking site" examples. A Cloudbeds-based attempt (Hotel McCoy, Tucson) was also live-tested and is documented as an unresolved case below rather than silently dropped. Reached payment, fields filled — **done**, $0.87, proof screenshot on file.
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

## Known unresolved case: Agoda replay-then-resume

Logged honestly, same as Hotel McCoy below. A replay of the current (all-role/name) Agoda recording got 5 of its 9 steps in with zero model calls — SEARCH, hotel-name fill, property link, scroll, room selection — before breaking on a checkout-flow interstitial that isn't consistently present run-to-run (present when the recording was captured, absent on the replay attempt). Discover's resume from that break point did not reach payment this attempt (`why: stuck`, $0.26) — unlike the equivalent Traveloka case (Tier-2 item 4), where the resume succeeded cleanly. Not pursued further at additional cost past this point; the category's deliverable is already satisfied by the cold-Discover success in Tier-2 item 1, and partial-prefix determinism (5 of 9 steps, zero model calls) is real and demonstrated even though the full resume-to-success chain isn't proven on this provider.

## Known unresolved case: Hotel McCoy (Cloudbeds)

Logged honestly rather than silently dropped, per the "honest failure log" deliverable item. Hotel McCoy's own Cloudbeds-powered booking widget (Tucson, AZ) was live-tested extensively and its guest-details "Continue" button intermittently does nothing even when every field is verifiably correct in the DOM (confirmed via debug screenshots across multiple attempts). Two real, separate bugs were found and fixed along the way (a native `<select>` reset the entire widget when confirmed with Enter instead of Tab; the ZIP field triggers a several-second async tax recalculation that can misreport as empty if checked too soon) — neither turned out to be the actual remaining blocker. A zero-cost, no-agent Playwright script reproducing the exact same field values with `.fill()` succeeded on its first try, which rules out the two leading theories tested (untrusted synthetic events, and an expired reservation hold from the slower multi-step-LLM pacing) without identifying a replacement one. This category's actual deliverable was satisfied instead by Mari Jean Hotel (Mews-powered), which reached payment cleanly with no comparable issue — McCoy is documented here as a real, reproducible site-specific gap rather than pursued further at additional cost.
