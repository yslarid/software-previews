// Runnable fictional CloseoutLink example. Run with Node 24.2+.
function receipt(rev, stage, repairs) {
  return Object.freeze({ rev, stage, repairs: Object.freeze(repairs.map(Object.freeze)) });
}

export function eastHallReceipt() {
  return receipt(1, 'Partial acceptance', [
    { id: 'PN-04', name: 'North door hardware', state: 'accepted', note: 'Pull fixed and aligned.' },
    { id: 'PN-07', name: 'Service hinge', state: 'accepted', note: 'Hinge movement checked.' },
    { id: 'PN-09', name: 'Entry door closer', state: 'flagged', note: 'Door latches too hard in the final ten degrees.' }
  ]);
}

// Each decision issues a new version. The earlier receipt remains readable.
export function recordDecision(previous, repairId, decision) {
  const repair = previous.repairs.find(item => item.id === repairId);
  if (!repair) throw new RangeError('Unknown repair.');
  let next;
  let stage;
  if (decision.type === 'submit' && repair.state === 'flagged') {
    const correction = decision.note?.trim();
    const reference = decision.reference?.trim();
    if (!correction || !reference) throw new Error('Include a correction note and field evidence.');
    next = { ...repair, state: 'review', correction, reference };
    stage = 'Correction submitted';
  } else if (decision.type === 'accept' && repair.state === 'review') {
    next = { ...repair, state: 'accepted' };
    stage = 'Item accepted';
  } else if (decision.type === 'return' && repair.state === 'review') {
    const note = decision.note?.trim();
    if (!note) throw new Error('Include the reason for returning this repair.');
    next = { id: repair.id, name: repair.name, state: 'flagged', note };
    stage = 'Returned for correction';
  } else {
    throw new Error('This repair cannot take that decision in its current state.');
  }

  const repairs = previous.repairs.map(item => item.id === repairId ? next : item);
  if (repairs.every(item => item.state === 'accepted')) stage = 'Final acceptance';
  return receipt(previous.rev + 1, stage, repairs);
}

if (import.meta.main) {
  const first = eastHallReceipt();
  const reviewed = recordDecision(first, 'PN-09', {
    type: 'submit', note: 'Adjusted the closing-speed valve and checked the latch.',
    reference: 'Latch-cycle field check'
  });
  const latest = recordDecision(reviewed, 'PN-09', { type: 'accept' });
  console.log(JSON.stringify({ first, latest }, null, 2));
}
