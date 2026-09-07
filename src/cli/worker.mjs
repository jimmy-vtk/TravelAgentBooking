// The thin job-store worker (README "Deliverable" - satisfies §02 steps 1 & 4). Reads one row, calls
// bookHotel(...), writes the result back. Not a service - runs once and exits.
//
// Usage: node src/cli/worker.mjs --job-id abc123
import { getJob, writeJobResult } from '../jobStore.mjs';
import { bookHotel } from '../bookHotel.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i]?.replace(/^--/, '')] = argv[i + 1];
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args['job-id']) {
  console.error('Usage: node src/cli/worker.mjs --job-id <id>');
  process.exit(1);
}

const job = getJob(args['job-id']);
if (!job) {
  console.error(`No job found with id ${args['job-id']}`);
  process.exit(1);
}

const result = await bookHotel({
  hotelName: job.hotel_name,
  checkIn: job.check_in,
  checkOut: job.check_out,
  roomType: job.room_type,
  guests: job.guests,
  providers: job.providers,
});

writeJobResult(job.id, {
  status: result.status,
  error: result.status === 'needs_review' ? JSON.stringify(result.attempts) : null,
  proof_url: result.proof ?? null,
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'reached_payment' ? 0 : 1);
