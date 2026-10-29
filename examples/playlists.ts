// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).
//
// Lists every playlist with its kind (roon / smart / qobuz / tidal ...), then
// (optionally) plays one on a zone.
//
//   ROON_HOST=192.168.0.68 ROON_CORE_ID=fafb763c-... node dist/examples/playlists.js
//   ... play <zoneId> <playlist name or id> [now|next|queue] [shuffle]
import { RoonLibraryClient } from '../src';

const host = process.env.ROON_HOST;
const coreId = process.env.ROON_CORE_ID;
if (!host || !coreId) {
  console.error('set ROON_HOST and ROON_CORE_ID');
  process.exit(2);
}
const [action, zoneArg, playlistArg, howArg, shuffleArg] = process.argv.slice(2);

async function main() {
  const roon = new RoonLibraryClient({ host: host!, coreId: coreId!, log: (m) => console.log('  [client]', m) });
  await roon.connect();
  console.log(`connected, ${roon.objectCount} objects`);
  console.log('zones:', roon.zoneIds().join(', '));

  const lists = roon.playlists();
  console.log(`${lists.length} playlists:`);
  for (const p of lists) console.log(`  [${p.kind}${p.type !== null ? ` ${p.type}` : ''}] ${p.name}  (${p.trackCount ?? '?'} tracks, id ${p.playlistId})`);

  if (action === 'play' && zoneArg && playlistArg) {
    const how = howArg === 'next' || howArg === 'queue' ? howArg : 'now';
    const played = await roon.playPlaylist(zoneArg, playlistArg, { how, shuffle: shuffleArg === 'shuffle' });
    console.log(`-> asked Roon to play "${played.name}" [${played.kind}]`);
  }
  roon.close();
}

main().catch((e) => {
  console.error('FAILED:', e.name, e.message);
  process.exit(1);
});
