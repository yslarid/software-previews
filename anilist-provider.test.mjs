import test from 'node:test';
import assert from 'node:assert/strict';
import { createAniListProvider, IncompletePage } from './anilist-provider.mjs';
import { snapshotOf, MemoryStore, ingestNext, buildRelease } from './animehalo.mjs';

const title = { id: 1, episodes: 26, title: { english: null, romaji: 'Example', native: null } };
const body = (media = [title]) => ({ data: { Page: { media } } });
const json = (payload, init) => Response.json(payload, init);
const records = [{key:'example', label:'Example', sources:['https://anilist.co/anime/1'], claims:[]}];

test('an actual GraphQL-shaped success drives the importer all the way to an immutable release', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://graphql.anilist.co');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    const {variables, query} = JSON.parse(options.body);
    assert.deepEqual(variables, {ids:[1], limit:1});
    assert.match(query, /media\(id_in: \$ids, type: ANIME\)/);
    return json(body());
  };
  const snapshot = await snapshotOf(records);
  const store = new MemoryStore(snapshot.hash);
  const reply = await ingestNext({snapshot, store, readPage:createAniListProvider({fetchImpl})});
  assert.equal(reply.kind, 'committed');
  assert.deepEqual(store.readCheckpoint().media[1], {title:'Example', episodes:26});
  const release = await buildRelease({snapshot, store, joinHash:snapshot.hash});
  store.promote(null, release);
  assert.equal(store.head, release.id);
});

test('HTTP 200 with partial GraphQL data cannot advance the cursor or mark titles gone', async () => {
  const snapshot = await snapshotOf(records);
  const store = new MemoryStore(snapshot.hash);
  const partial = {...body([]), errors:[{message:'Timed out resolving field',path:['Page','media']}]};
  const before = store.readCheckpoint();
  const readPage = createAniListProvider({fetchImpl: async () => json(partial)});
  await assert.rejects(ingestNext({snapshot,store,readPage}), IncompletePage);
  assert.deepEqual(store.readCheckpoint(), before);
});

test('429 respects Retry-After; the reset timestamp is a fallback for an unreadable header', async () => {
  for (const [headers, expected] of [
    [{'Retry-After':'40'},'40'],
    [{'Retry-After':'Wed, 18 Nov 2026 13:00:00 GMT'},'Wed, 18 Nov 2026 13:00:00 GMT'],
    [{'Retry-After':'invalid','X-RateLimit-Reset':'140'},'40'],
    [{},null]
  ]) {
    const fetchImpl = async () => new Response(null,{status:429,headers});
    assert.deepEqual(await createAniListProvider({fetchImpl,now:()=>100000})([1]), {status:429,retryAfter:expected});
  }
});

test('schema drift, unexpected records and duplicates cannot look like a complete page', async () => {
  for (const envelope of [null, {}, {errors:{}}, body([title,title]), body([{...title,id:9}]), body([{...title,episodes:undefined}])]) {
    await assert.rejects(createAniListProvider({fetchImpl:async()=>json(envelope)})([1]), IncompletePage);
  }
});

test('a successfully completed empty response is distinct from an unavailable upstream', async () => {
  const noRows = createAniListProvider({fetchImpl:async()=>json(body([]))});
  const outage = createAniListProvider({fetchImpl:async()=>new Response(null,{status:503})});
  assert.deepEqual(await noRows([1]),{status:200,rows:[]});
  assert.deepEqual(await outage([1]),{status:503});
});

test('invalid page input is rejected before a request is sent and a cancelled request stays cancelled', async () => {
  const readPage = createAniListProvider({fetchImpl:()=>assert.fail('Unexpected network call')});
  for (const ids of [[],[1,1],[0],[-1],[2147483648],['1'],Array.from({length:51},(_,i)=>i+1)]) {
    await assert.rejects(readPage(ids), RangeError);
  }
  const controller=new AbortController();controller.abort();
  const cancelled=createAniListProvider({signal:controller.signal,fetchImpl:async(_url, options)=>options.signal.throwIfAborted()});
  await assert.rejects(cancelled([1]),{name:'AbortError'});
});
