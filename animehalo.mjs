import { createHash } from "node:crypto";

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
