import { createAniListProvider } from './anilist-provider.mjs';
import { snapshotOf, MemoryStore, ingestNext, buildRelease } from './animehalo.mjs';

const [flag, rawId] = process.argv.slice(2);
if (flag !== '--live' || !/^[1-9]\d*$/.test(rawId ?? '') || Number(rawId) > 2147483647) {
  console.error('Usage: node probe-anilist.mjs --live <AniList anime ID>');
  process.exitCode = 2;
} else {
  try {
    const record = { key: 'selected-title', label: 'Requested title', sources: ['https://anilist.co/anime/' + rawId], claims: [] };
    const snapshot = await snapshotOf([record]);
    const store = new MemoryStore(snapshot.hash);
    const result = await ingestNext({ snapshot, store, readPage: createAniListProvider() });
    if (result.kind === 'throttled') {
      console.log('Rate limited. The earliest retry is ' + new Date(result.until).toISOString());
      process.exitCode = 1;
    } else {
      const release = await buildRelease({ snapshot, store, joinHash: snapshot.hash });
      store.promote(null, release);
      console.log(JSON.stringify({providerId:Number(rawId), media:store.readCheckpoint().media[rawId], release:release.id},null,2));
    }
  } catch (error) {
    console.error('No release was published:', error.message);
    process.exitCode = 1;
  }
}
