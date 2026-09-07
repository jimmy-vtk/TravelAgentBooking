import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

process.env.RECORDINGS_DIR = '.test-recordings';
const { getRecording, saveRecording } = await import('../src/recordingStore.mjs');

test.after(() => {
  if (existsSync('.test-recordings')) rmSync('.test-recordings', { recursive: true, force: true });
});

test('recordingStore: missing recording returns null', () => {
  assert.equal(getRecording('Nonexistent Hotel', 'Trip.com'), null);
});

test('recordingStore: save then get round-trips exactly, scoped per (hotel, provider)', () => {
  const steps = [{ action: 'click', role: 'button', name: 'Search' }];
  saveRecording('Sofitel Mumbai BKC', 'Trip.com', steps);

  assert.deepEqual(getRecording('Sofitel Mumbai BKC', 'Trip.com'), steps);
  // a different hotel on the same provider is a DIFFERENT recording (per-hotel-per-site scope)
  assert.equal(getRecording('Hotel McCoy', 'Trip.com'), null);
  // the same hotel on a different provider is also a different recording
  assert.equal(getRecording('Sofitel Mumbai BKC', 'Halalbooking'), null);
});

test('recordingStore: saveRecording collapses consecutive duplicate steps, keeping the last attempt', () => {
  // REGRESSION (found live on Agoda, 2026-09): a partial-replay-then-resume merge produced a recording
  // with the same hotel link clicked 3x in a row and the same phone field filled 5x in a row.
  const steps = [
    { action: 'click', role: 'link', name: 'HARRIS Hotel Seminyak', field: null },
    { action: 'click', role: 'link', name: 'HARRIS Hotel Seminyak', field: null },
    { action: 'click', role: 'link', name: 'HARRIS Hotel Seminyak', field: null },
    { action: 'fill', role: 'textbox', name: 'Mobile number', field: 'phone', text: '170 0000000' },
    { action: 'fill', role: 'textbox', name: 'Mobile number', field: 'phone', text: '170 0000000' },
    { action: 'fill', role: 'textbox', name: 'Mobile number', field: 'phone', text: '1700000000' },
    { action: 'click', role: 'button', name: 'NEXT: FINAL STEP', field: null },
  ];
  saveRecording('Harris Hotel Seminyak', 'Agoda', steps);

  const saved = getRecording('Harris Hotel Seminyak', 'Agoda');
  assert.equal(saved.length, 3);
  assert.equal(saved[0].name, 'HARRIS Hotel Seminyak');
  assert.equal(saved[1].text, '1700000000'); // the LAST fill attempt's value, not the first
  assert.equal(saved[2].name, 'NEXT: FINAL STEP');
});

test('recordingStore: saveRecording drops a fill/select step that targets a non-editable role', () => {
  // REGRESSION (found live on Agoda, 2026-09): a one-off mis-click recorded as
  // `fill [button "Sign in"] = "Max"` (the model briefly typed into the wrong element before correcting
  // itself two steps later) - .fill() on a button throws immediately during replay, hard-breaking it.
  const steps = [
    { action: 'fill', role: 'button', name: 'Sign in', field: 'firstName', text: 'Max' },
    { action: 'click', role: 'button', name: 'Close', field: null },
    { action: 'fill', role: 'textbox', name: 'First name *', field: 'firstName', text: 'Max' },
  ];
  saveRecording('Harris Hotel Seminyak', 'AnotherProvider', steps);

  const saved = getRecording('Harris Hotel Seminyak', 'AnotherProvider');
  assert.equal(saved.length, 2);
  assert.equal(saved[0].name, 'Close');
  assert.equal(saved[1].role, 'textbox');
});

test('REGRESSION (found live 2026-09 on Mari Jean Hotel/Mews): a fill step with NO role recorded at all (a pixel fallback) must be KEPT, not treated the same as a wrong-role mis-click', () => {
  // The saved recording ended up with zero fill steps whatsoever because every pixel-fallback fill (role:
  // null - an interstitial disrupted ref-matching, real evidence the agent typed something, exactly what
  // verify.mjs's requiredFieldsFilled() documents trusting) was being dropped identically to a genuine
  // wrong-role mis-click. Missing is not the same as wrong.
  const steps = [
    { action: 'fill', role: null, name: null, x: 400, y: 300, field: 'firstName', text: 'Max' },
    { action: 'fill', role: null, name: null, x: 400, y: 340, field: 'lastName', text: 'Mustermann' },
    { action: 'click', role: 'button', name: 'Continue', field: null },
  ];
  saveRecording('Mari Jean Hotel', 'Own website (Mews)', steps);

  const saved = getRecording('Mari Jean Hotel', 'Own website (Mews)');
  assert.equal(saved.length, 3);
  assert.equal(saved[0].field, 'firstName');
  assert.equal(saved[0].text, 'Max');
  assert.equal(saved[1].field, 'lastName');
});
