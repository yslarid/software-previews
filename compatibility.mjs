// The original synchronous hash helpers run in Node. Browser consumers of the
// new release engine can still import that engine without a Node dependency.
const createHash = globalThis.process?.versions?.node
  ? (await import('node:crypto')).createHash
  : () => { throw new Error('The synchronous catalog helpers require Node.js.'); };

const BUCKET_COUNT = 4;

// The example deliberately uses four fixed buckets so the cache behaviour
// is visible in a small catalog. The title ID determines its destination.
function bucketFor(id) {
  const digest = createHash("sha256").update(id).digest();
  return digest[0] % BUCKET_COUNT;
}

export function buildCatalog(records) {
  const buckets = Array.from({ length: BUCKET_COUNT }, () => new Map());

  for (const { id, title } of records) {
    if (typeof id !== "string" || !id || typeof title !== "string" || !title) {
      throw new TypeError("Every catalog entry needs a string ID and title.");
    }
    const bucket = buckets[bucketFor(id)];
    if (bucket.has(id)) throw new RangeError("Duplicate catalog ID: " + id);
    bucket.set(id, title);
  }

  const files = new Map();
  const manifest = buckets.map((bucket, index) => {
    const ids = [...bucket.keys()].sort();
    const body = JSON.stringify(ids.map(id => ({ id, title: bucket.get(id) })));
    const version = createHash("sha256").update(body).digest("hex").slice(0, 16);
    const path = `titles-${index}-${version}.json`;
    files.set(path, body);
    return path;
  });
  return { manifest, files };
}

// A browser can request this single path for a title detail view.
export function chunkPath(manifest, id) {
  return manifest[bucketFor(id)];
}

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
