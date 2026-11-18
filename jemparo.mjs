// A SetAhead visit can have a date, a time window, or a time still to be
// confirmed. A public handoff explicitly selects the fields meant to travel.
function verifiedDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError("Provide a calendar date in YYYY-MM-DD format.");
  }
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError("That calendar date does not exist.");
  }
  return value;
}

function timingLabel(timing) {
  if (timing.kind === "office-confirms") return "The office will confirm timing.";
  const day = verifiedDate(timing.date);
  if (timing.kind === "date") return day;
  if (timing.kind !== "window") throw new RangeError("Unknown timing option.");

  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!clock.test(timing.start) || !clock.test(timing.end) || timing.start >= timing.end) {
    throw new RangeError("A same-day window needs two increasing 24-hour times.");
  }
  return `${day} · ${timing.start}–${timing.end} local time`;
}

export function readinessCard(booking, { shareNote = false } = {}) {
  const card = { reference: booking.reference, timing: timingLabel(booking.timing) };
  if (shareNote === true && booking.siteNote?.trim()) card.siteNote = booking.siteNote.trim();
  return card;
}
