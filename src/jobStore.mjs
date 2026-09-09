// Job store - matches the booking_jobs schema from the playbook's section 03. SQLite here (local dev,
// no external dependency); swap for a Postgres-backed implementation with the same three functions once
// TakeMeTo's staging key is provided - nothing above this module needs to change.
import Database from 'better-sqlite3';

const DB_PATH = process.env.JOB_DB_PATH || 'jobs.sqlite';

function open() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL DEFAULT 'hotel',
      hotel_name TEXT,
      check_in TEXT,
      check_out TEXT,
      room_type TEXT,
      guests INTEGER,
      providers TEXT,        -- JSON array
      selected_provider TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      proof_url TEXT,
      cancel_url TEXT
    )
  `);
  return db;
}

export function getJob(id) {
  const db = open();
  try {
    const row = db.prepare('SELECT * FROM booking_jobs WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, providers: row.providers ? JSON.parse(row.providers) : [] };
  } finally {
    db.close();
  }
}

export function insertJob(job) {
  const db = open();
  try {
    db.prepare(`
      INSERT INTO booking_jobs (id, job_type, hotel_name, check_in, check_out, room_type, guests, providers, selected_provider, status)
      VALUES (@id, 'hotel', @hotel_name, @check_in, @check_out, @room_type, @guests, @providers, @selected_provider, 'pending')
    `).run({
      id: job.id,
      hotel_name: job.hotel_name,
      check_in: job.check_in,
      check_out: job.check_out,
      room_type: job.room_type ?? null,
      guests: job.guests,
      providers: JSON.stringify(job.providers),
      selected_provider: job.selected_provider ?? job.providers?.[0]?.name ?? null,
    });
  } finally {
    db.close();
  }
}

export function writeJobResult(id, { status, error = null, proof_url = null }) {
  const db = open();
  try {
    db.prepare('UPDATE booking_jobs SET status = ?, error = ?, proof_url = ? WHERE id = ?')
      .run(status, error, proof_url, id);
  } finally {
    db.close();
  }
}

// GUARDRAIL (colleague review, 2026-09): the data contract (§03) defines `selected_provider` as a field
// distinct from `providers` - "the provider to start with, USUALLY the cheapest" - implying it isn't
// necessarily just providers[0]. worker.mjs previously read `job.providers` straight into bookHotel() and
// never looked at `job.selected_provider` at all: the field round-tripped correctly through storage (see
// the test above) but was functionally inert - a job whose selected provider differed from providers[0]
// (a pinned/preferred partner, a promo override) would have silently started from the wrong one. This
// resolves the ACTUAL attempt order bookHotel() should use: the selected provider first if it's present in
// the list, the rest following in their given (price-sorted) order - falling back to the given order
// unchanged if selectedProviderName is missing or names something no longer in the list (e.g. sold out
// since the job was queued) rather than hard-failing on that alone.
export function orderProviders(providers, selectedProviderName) {
  const list = providers ?? [];
  if (!selectedProviderName) return list;
  const idx = list.findIndex((p) => p?.name === selectedProviderName);
  if (idx <= 0) return list; // not found, or already first - nothing to reorder
  return [list[idx], ...list.slice(0, idx), ...list.slice(idx + 1)];
}
