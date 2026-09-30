// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).
//
// Shows what every zone is playing with its heart / library state, then (optionally)
// hearts, un-hearts or adds the track in one zone.
//
//   ROON_HOST=192.168.0.68 ROON_CORE_ID=fafb763c-9ad0-4f07-887d-44e19b8374e0 node dist/examples/heart-now-playing.js
//   ... heart <zoneId>      heart what that zone is playing (adds a single track to the library first if needed)
//   ... unheart <zoneId>
//   ... add <zoneId> [track|album]
import { RoonLibraryClient, TrackInfo } from '../src';

const host = process.env.ROON_HOST;
const coreId = process.env.ROON_CORE_ID;
if (!host || !coreId) {
  console.error('set ROON_HOST and ROON_CORE_ID');
  process.exit(2);
}
const [action, zoneArg, modeArg] = process.argv.slice(2);

const show = (t: TrackInfo | null) =>
  t
    ? `"${t.title}"  library=${t.inLibrary ? 'yes' : 'no'}  heart=${t.favorite ? 'yes' : 'no'}  source=${t.source}` +
      (t.album ? `  album="${t.album.title}" (library=${t.album.inLibrary ? 'yes' : 'no'}, heart=${t.album.favorite ? 'yes' : 'no'})` : '')
    : '(nothing loaded)';

async function main() {
  const roon = new RoonLibraryClient({ host: host!, coreId: coreId!, log: (m) => console.log('  [client]', m) });
  roon.on('track', (zoneId, track) => console.log(`* ${zoneId}: ${show(track)}`));
  roon.on('disconnected', (reason) => console.log('disconnected', reason?.message ?? ''));
  await roon.connect();
  console.log(`connected, ${roon.objectCount} objects, zones: ${roon.zoneIds().length}`);

  if (action && zoneArg) {
    if (action === 'heart') console.log('->', show(await roon.setFavorite(zoneArg, true, { addToLibrary: 'track' })));
    else if (action === 'unheart') console.log('->', show(await roon.setFavorite(zoneArg, false)));
    else if (action === 'add') console.log('->', show(await roon.addToLibrary(zoneArg, modeArg === 'album' ? 'album' : 'track')));
    else if (action === 'heartalbum') console.log('->', show(await roon.setAlbumFavorite(zoneArg, true)));
    else if (action === 'unheartalbum') console.log('->', show(await roon.setAlbumFavorite(zoneArg, false)));
    else console.log('unknown action', action);
    roon.close();
    return;
  }
  console.log('watching for changes, Ctrl+C to stop');
}

main().catch((e) => {
  console.error('FAILED:', e.name, e.message);
  process.exit(1);
});
