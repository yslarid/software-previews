// Independent, browser-compatible catalog recovery model. The provider and store are injected.
export class StaleWrite extends Error {}
export class SnapshotMismatch extends Error {}

export function retryDelay(header, now) {
  if (typeof header === "string" && /^\d+$/.test(header.trim())) return Number(header) * 1000;
  const date = typeof header === "string" ? Date.parse(header) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : 60_000;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

async function digest(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

export function partition(key, count) {
  if (!Number.isInteger(count) || count < 1 || count > 4096 || (count & (count - 1)) !== 0) {
    throw new RangeError("Partition count must be a power of two between 1 and 4096.");
  }
  let value = 2166136261;
  for (const byte of new TextEncoder().encode(key)) value = Math.imul(value ^ byte, 16777619);
  return (value >>> 0) % count;
}

export function identity(record) {
  for (const source of record.sources) {
    const match = /^https:\/\/anilist\.co\/anime\/([1-9]\d*)\/?$/.exec(source);
    if (match && Number.isSafeInteger(Number(match[1]))) return { id: Number(match[1]), source: "Catalog URL" };
  }
  const claim = record.claims.find(item => item.rank !== "deprecated" && Number.isSafeInteger(item.id) && item.id > 0);
  return claim ? { id: claim.id, source: "Wikidata P8729" } : null;
}

export async function snapshotOf(records) {
  const ids = new Set();
  const keys = new Set();
  const titles = records.map(record => {
    const link = identity(record);
    if (!link || !record.key || ids.has(link.id) || keys.has(record.key)) {
      throw new Error("An ambiguous or missing title identity prevents this join.");
    }
    ids.add(link.id);
    keys.add(record.key);
    return { key: record.key, label: record.label, ...link };
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return { hash: await digest(JSON.stringify(canonical(records.slice().sort((a,b) => a.key < b.key ? -1 : 1)))), titles };
}

export function validatePage(ids, rows) {
  if (!Array.isArray(rows)) throw new TypeError("The provider omitted the media list.");
  const wanted = new Set(ids);
  const result = {};
  for (const row of rows) {
    if (!row || !wanted.has(row.id) || Object.hasOwn(result, row.id) ||
        typeof row.title !== "string" || !row.title.trim() ||
        !(row.episodes === null || (Number.isSafeInteger(row.episodes) && row.episodes >= 0))) {
      throw new Error("Provider page contains an unexpected, duplicate or malformed title.");
    }
    result[row.id] = { title: row.title, episodes: row.episodes };
  }
  for (const id of ids) if (!Object.hasOwn(result, id)) result[id] = null;
  return result;
}

// Each synchronous method below is one transaction in the test store. Production adapters
// need a conditional write with equivalent isolation for each compare-and-swap operation.
export class MemoryStore {
  constructor(snapshotHash) {
    this.checkpoint = { snapshotHash, revision: 0, cursor: 0, media: {}, blockedUntil: 0 };
    this.head = null;
    this.blobs = new Map();
    this.manifests = new Map();
  }
  readCheckpoint() { return structuredClone(this.checkpoint); }
  writeCheckpoint(expected, next) {
    if (this.checkpoint.revision !== expected || this.checkpoint.snapshotHash !== next.snapshotHash) {
      throw new StaleWrite("Checkpoint changed while this worker was reading the provider.");
    }
    this.checkpoint = structuredClone({ ...next, revision: expected + 1 });
  }
  promote(expectedHead, release) {
    if (this.head !== expectedHead) throw new StaleWrite("Another publisher advanced the release pointer.");
    for (const hash of release.chunks) {
      if (!this.blobs.has(hash)) throw new Error("Cannot publish a manifest with missing artifacts.");
    }
    this.manifests.set(release.id, structuredClone(release));
    this.head = release.id;
  }
}

export async function ingestNext({ store, snapshot, readPage, now = Date.now, pageSize = 3, beforeCommit }) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("Invalid page size.");
  const saved = store.readCheckpoint();
  if (saved.snapshotHash !== snapshot.hash) throw new SnapshotMismatch("The cursor belongs to a different input snapshot.");
  if (now() < saved.blockedUntil) return { kind: "held", until: saved.blockedUntil };
  const page = snapshot.titles.slice(saved.cursor, saved.cursor + pageSize);
  if (!page.length) return { kind: "complete" };
  const ids = page.map(item => item.id);
  const reply = await readPage(ids);
  if (reply.status === 429) {
    const until = now() + retryDelay(reply.retryAfter, now());
    store.writeCheckpoint(saved.revision, { ...saved, blockedUntil: until });
    return { kind: "throttled", until, ids };
  }
  if (reply.status !== 200) throw new Error("Provider rejected the page (HTTP " + reply.status + ").");
  const media = validatePage(ids, reply.rows);
  if (beforeCommit) await beforeCommit();
  store.writeCheckpoint(saved.revision, {
    ...saved, cursor: saved.cursor + page.length, media: { ...saved.media, ...media }, blockedUntil: 0
  });
  return { kind: "committed", ids, missing: ids.filter(id => media[id] === null) };
}

export async function buildRelease({ store, snapshot, joinHash, partitions = 4, schema = 1 }) {
  const point = store.readCheckpoint();
  if (joinHash !== snapshot.hash || point.snapshotHash !== snapshot.hash) {
    throw new SnapshotMismatch("Enrichment and catalog refer to different source snapshots.");
  }
  if (point.cursor !== snapshot.titles.length) throw new Error("The import is incomplete.");
  partition("check", partitions);
  const parts = Array.from({ length: partitions }, () => []);
  for (const item of snapshot.titles) {
    if (!Object.hasOwn(point.media, item.id)) throw new Error("A completed cursor is missing a record.");
    const facts = point.media[item.id];
    parts[partition(item.key, partitions)].push({ key: item.key, title: facts?.title ?? item.label, episodes: facts?.episodes ?? null });
  }
  const chunks = await Promise.all(parts.map(async records => {
    const body = JSON.stringify(canonical({ schema, records }));
    const hash = await digest(body);
    if (!store.blobs.has(hash)) store.blobs.set(hash, body);
    return hash;
  }));
  const id = await digest(JSON.stringify({ schema, partitions, chunks, source: snapshot.hash }));
  return { id, chunks, partitions, schema, source: snapshot.hash };
}

// Original public example entry points.
export { buildCatalog, chunkPath } from './compatibility.mjs';
