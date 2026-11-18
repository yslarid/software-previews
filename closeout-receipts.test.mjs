import assert from 'node:assert/strict';
import test from 'node:test';
import { eastHallReceipt, recordDecision } from './closeout-receipts.mjs';

const correction = {
  type: 'submit', note: 'Adjusted the closing-speed valve and checked the latch.',
  reference: 'Latch-cycle field check'
};
const closer = receipt => receipt.repairs.find(item => item.id === 'PN-09');

test('accepting the closer correction preserves the first East Hall receipt', () => {
  const first = eastHallReceipt();
  const original = structuredClone(first);
  const review = recordDecision(first, 'PN-09', correction);
  const latest = recordDecision(review, 'PN-09', { type: 'accept' });

  assert.deepEqual(first, original);
  assert.equal(closer(first).state, 'flagged');
  assert.equal(closer(review).state, 'review');
  assert.equal(closer(latest).state, 'accepted');
  assert.equal(closer(latest).correction, correction.note);
  assert.equal(closer(latest).reference, correction.reference);
  assert.deepEqual([first.rev, review.rev, latest.rev], [1, 2, 3]);
  assert.equal(latest.stage, 'Final acceptance');
  for (const id of ['PN-04', 'PN-07']) {
    const previous = original.repairs.find(item => item.id === id);
    assert.equal(previous.state, 'accepted');
    assert.deepEqual(latest.repairs.find(item => item.id === id), previous);
  }
});

test('a returned repair can be corrected again while earlier notes stay readable', () => {
  const first = eastHallReceipt();
  const review = recordDecision(first, 'PN-09', correction);
  const reason = 'Closer still slams at the end of travel.';
  const returned = recordDecision(review, 'PN-09', { type: 'return', note: reason });
  const revised = recordDecision(returned, 'PN-09', { ...correction, note: 'Retuned and cycled the door.' });
  const accepted = recordDecision(revised, 'PN-09', { type: 'accept' });

  assert.equal(closer(first).note, 'Door latches too hard in the final ten degrees.');
  assert.equal(closer(review).correction, correction.note);
  assert.equal(closer(returned).note, reason);
  assert.equal(closer(accepted).correction, 'Retuned and cycled the door.');
  assert.equal(accepted.rev, 5);
});

test('the client can accept only a submitted correction', () => {
  const first = eastHallReceipt();
  assert.throws(() => recordDecision(first, 'PN-09', { type: 'accept' }), /current state/);
  assert.throws(() => recordDecision(first, 'PN-04', correction), /current state/);
  assert.throws(() => recordDecision(first, 'PN-09', { ...correction, note: ' ' }), /note/);
});
