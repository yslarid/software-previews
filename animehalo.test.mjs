import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, StaleWrite, SnapshotMismatch, snapshotOf, ingestNext, buildRelease, identity, partition } from "./animehalo.mjs";

const inputs = Array.from({ length: 10 }, (_, i) => ({
  key: "s" + i, label: "Fixture " + i, sources: [], claims: [{ id: i + 1, rank: "normal" }]
}));
const rows = ids => ({ status: 200, rows: ids.map(id => ({ id, title: "Series " + id, episodes: id })) });
async function setup(input = inputs) {
  const snapshot = await snapshotOf(input);
  return { snapshot, store: new MemoryStore(snapshot.hash), readPage: async ids => rows(ids) };
}
async function finish(params) { while ((await ingestNext(params)).kind === "committed") {} }
async function release(p) { return buildRelease({ ...p, joinHash: p.snapshot.hash }); }

test("source links take precedence and obsolete claims cannot join unrelated titles", async () => {
  assert.deepEqual(identity({ sources: ["https://anilist.co/anime/9"], claims: [{id:4,rank:"preferred"}]}),{source:"Catalog URL",id:9});
  const record = { key:"x",label:"X",sources:[],claims:[{id:8,rank:"deprecated"},{id:5,rank:"normal"}]};
  assert.equal(identity(record).id,5);
  await assert.rejects(snapshotOf([record,{...record,key:"other"}]),/ambiguous/);
});
test("retry admission, including after process restart, holds requests until the deadline",async()=>{
  const p=await setup(); let now=Date.parse("2026-01-01T00:00:00Z"),calls=0;
  const readPage=async ids => ++calls===1 ? {status:429,retryAfter:new Date(now+4000).toUTCString()} : rows(ids);
  const run=()=>ingestNext({...p,now:()=>now,readPage});
  assert.equal((await run()).kind,"throttled"); now+=3999;
  assert.equal((await run()).kind,"held"); assert.equal(calls,1); now++;
  assert.equal((await run()).kind,"committed"); assert.equal(p.store.readCheckpoint().cursor,3);
});
test("failed checkpoint writes replay the same ids; completed pages are not fetched again",async()=>{
  const p=await setup(), calls=[];
  p.readPage=async ids=>{calls.push(ids);return rows(ids)};
  await ingestNext(p);
  await assert.rejects(ingestNext({...p,beforeCommit:()=>{throw Error("disk fault")}}),/disk fault/);
  assert.equal(p.store.readCheckpoint().cursor,3); await ingestNext(p);
  assert.deepEqual(calls[1],calls[2]); assert.notDeepEqual(calls[0],calls[2]);
});
test("two overlapping workers cannot regress a committed cursor",async()=>{
  const p=await setup(); let releaseSlow;
  let started;const began=new Promise(resolve=>{started=resolve});
  const slow=ingestNext({...p,readPage:async ids=>{started();await new Promise(r=>{releaseSlow=r});return rows(ids)}});
  await began;await ingestNext(p);releaseSlow();await assert.rejects(slow,StaleWrite);
  assert.equal(p.store.readCheckpoint().revision,1);
});
test("only a valid complete success can record a missing id",async()=>{
  const p=await setup();
  for (const reply of [{status:502},{status:200,rows:{}},{status:200,rows:[...rows([1,1]).rows]},{status:200,rows:rows([99]).rows}]) {
    await assert.rejects(ingestNext({...p,readPage:async()=>reply}));assert.equal(p.store.readCheckpoint().cursor,0);
  }
  const result=await ingestNext({...p,readPage:async ids=>rows(ids.slice(1))});
  assert.deepEqual(result.missing,[1]);assert.equal(p.store.readCheckpoint().media[1],null);
});
test("build rejects incomplete or mixed-generation inputs; existing head stays readable",async()=>{
  const p=await setup();
  await assert.rejects(release(p),/incomplete/);await finish(p);
  const first=await release(p);p.store.promote(null,first);
  await assert.rejects(buildRelease({...p,joinHash:"stale"}),SnapshotMismatch);
  assert.equal(p.store.head,first.id);
});
test("one edited title changes exactly one partition; previous blobs remain readable",async()=>{
  const p=await setup();await finish(p);
  const first=await release(p);p.store.promote(null,first);
  const ck=p.store.readCheckpoint();ck.media[4].episodes++;p.store.writeCheckpoint(ck.revision,ck);
  const next=await release(p);
  const changed=next.chunks.flatMap((hash,i)=> hash===first.chunks[i]?[]:[i]);
  assert.deepEqual(changed,[partition("s3",4)]);assert.equal(p.store.head,first.id);
  p.store.promote(first.id,next);assert(p.store.blobs.has(first.chunks[changed[0]]));
  assert.throws(()=>p.store.promote(first.id,first),StaleWrite);
});
test("identical artifact content retains distinct manifests for different source snapshots",async()=>{
  const a=await setup(), b=await setup(inputs.map(row=>({...row,extraEvidence:"second source"})));
  await finish(a);await finish(b);
  const ra=await release(a),rb=await release(b);
  assert.deepEqual(ra.chunks,rb.chunks);assert.notEqual(ra.source,rb.source);assert.notEqual(ra.id,rb.id);
});
