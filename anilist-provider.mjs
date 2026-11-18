// Read-only transport for the catalog worker and the optional browser inspection.
// A successful HTTP status alone cannot prove an entire GraphQL page was read.
const ENDPOINT = 'https://graphql.anilist.co';
const QUERY = `query CatalogPage($ids: [Int], $limit: Int!) {
  Page(page: 1, perPage: $limit) {
    media(id_in: $ids, type: ANIME) {
      id
      title { english romaji native }
      episodes
    }
  }
}`;

export class IncompletePage extends Error {}

function retryHint(headers, now) {
  const raw = headers.get('Retry-After');
  if (raw && (/^\d+$/.test(raw) || Number.isFinite(Date.parse(raw)))) return raw;
  const reset = headers.get('X-RateLimit-Reset');
  if (reset && /^\d+$/.test(reset)) {
    return String(Math.max(0, Math.ceil(Number(reset) - now() / 1000)));
  }
  return null; // The worker applies its conservative default when neither header is readable.
}

function normalizeRows(ids, items) {
  if (!Array.isArray(items)) throw new IncompletePage('The response did not contain a media page.');
  const requested = new Set(ids);
  const seen = new Set();
  return items.map(item => {
    if (!item || !requested.has(item.id) || seen.has(item.id)) {
      throw new IncompletePage('The response contained an unexpected or repeated ID.');
    }
    const title = [item.title?.english, item.title?.romaji, item.title?.native]
      .find(name => typeof name === 'string' && name.trim());
    if (!title || !(item.episodes === null || (Number.isSafeInteger(item.episodes) && item.episodes >= 0))) {
      throw new IncompletePage('The response contained an incomplete media record.');
    }
    seen.add(item.id);
    return { id: item.id, title: title.trim(), episodes: item.episodes };
  });
}

export function createAniListProvider({ fetchImpl = globalThis.fetch, signal, now = Date.now } = {}) {
  return async function readPage(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 ||
        ids.some(id => !Number.isInteger(id) || id <= 0 || id > 2147483647) ||
        new Set(ids).size !== ids.length) {
      throw new RangeError('A page must request 1–50 distinct positive GraphQL Int IDs.');
    }
    const timeout = AbortSignal.timeout(12_000);
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({ query: QUERY, variables: { ids, limit: ids.length } })
    });
    if (response.status === 429) return { status: 429, retryAfter: retryHint(response.headers, now) };
    if (response.status !== 200) return { status: response.status };
    // Never turn partial data into "missing" records. A failed field resolver can omit
    // a title from a page even though it still exists in the provider's catalog.
    const envelope = await response.json();
    if (!envelope || (envelope.errors !== undefined &&
        (!Array.isArray(envelope.errors) || envelope.errors.length > 0))) {
      throw new IncompletePage('AniList returned GraphQL errors. The page can be retried.');
    }
    return { status: 200, rows: normalizeRows(ids, envelope.data?.Page?.media) };
  };
}
