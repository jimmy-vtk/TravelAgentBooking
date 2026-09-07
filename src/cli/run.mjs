// Direct invocation - no job store involved. For live smoke tests / proof screenshots.
//
// Usage:
//   node src/cli/run.mjs --hotel "Sofitel Mumbai BKC" --checkin 2026-10-15 --checkout 2026-10-18 \
//     --guests 2 --roomtype "Luxury King Room" --providers providers.json
//
// providers.json: [{ "name": "Trip.com", "homepage": "https://us.trip.com", "pricePerNight": 207 }, ...]
// (pre-sorted by price, same shape as the section-03 `providers` field, minus the raw SerpApi click-URL -
// see README's "on-site search, not the deep link" note for why homepage is what's supplied here.)
import { readFileSync } from 'node:fs';
import { bookHotel } from '../bookHotel.mjs';
import { summarize } from '../costLog.mjs';

const BOOLEAN_FLAGS = new Set(['verbose']);
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]?.replace(/^--/, '');
    if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
    out[key] = argv[i + 1];
    i++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.hotel || !args.checkin || !args.checkout || !args.guests || !args.providers) {
  console.error('Usage: node src/cli/run.mjs --hotel "..." --checkin YYYY-MM-DD --checkout YYYY-MM-DD --guests N --providers providers.json [--roomtype "..."]');
  process.exit(1);
}

const providers = JSON.parse(readFileSync(args.providers, 'utf8'));

const result = await bookHotel({
  hotelName: args.hotel,
  checkIn: args.checkin,
  checkOut: args.checkout,
  roomType: args.roomtype || null,
  guests: Number(args.guests),
  providers,
  onStep: args.verbose
    ? (s) => console.error(`[step ${s.step}] ${s.action}${s.name ? ` [${s.role} "${s.name}"]` : ''}${s.text ? ` = "${s.text}"` : ''}${s.field ? ` (field: ${s.field})` : ''}${s.why ? ` why=${s.why}` : ''} - ${s.reason || ''}`)
    : undefined,
});

console.log(JSON.stringify(result, null, 2));

const totals = summarize();
console.error(`\n[cost-log] running total: ${totals.attempts} attempt(s), ${totals.successes} success(es), $${totals.totalCostUsd.toFixed(4)}, ${totals.totalApiCalls} API call(s) — logged to ${process.env.COST_LOG_PATH || 'cost-log.jsonl'}`);

process.exit(result.status === 'reached_payment' ? 0 : 1);
