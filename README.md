# roon-library-controls

Heart the track a Roon zone is playing, and add it (or its album) to your Roon library, from your own Node.js program.

Roon's official extension API can't do either of these. This small library talks to the Core the way the Roon desktop app does, over Roon's internal protocol on port 9332. It works today (tested on Roon 2.73), and it is **unofficial and experimental**: Roon changes this protocol whenever they like, so any Roon update can break it without warning. Treat it as a nice-to-have feature, and give your users a way to turn it off.

Built for the [Roon: Dialed Up](https://marketplace.elgato.com/product/roon-dialed-up-f76699d9-4266-4d4a-ad94-eaddd148daa9) Stream Deck plugin and [Roon: Toasted](https://github.com/Vulkandr/roon-toasted). Not affiliated with or endorsed by Roon Labs.

## What it does

- Reports what each zone is playing, with its **heart** and **in library** state, live (the Core pushes changes to you, including hearts set in Roon itself).
- **Heart / un-heart** the playing track.
- **Add to library**: the playing track on its own, or its whole album (Roon's own "+" adds the album; many people prefer single songs, others don't want loose tracks in their library, so both are here).
- **Heart / un-heart the album**.

On purpose it does **not** ban, remove from the library, or delete anything.

## Install

```
npm install roon-library-controls
```

Node 18 or newer. No dependencies.

## Use

You need two things every Roon extension already has: the Core's address and its Core id (the `unique_id` from SOOD discovery, or `core_id` from the extension API). Zone ids are the same strings the extension API gives you.

```js
const { RoonLibraryClient } = require('roon-library-controls');

const roon = new RoonLibraryClient({
  host: '192.168.0.68',
  coreId: 'fafb763c-9ad0-4f07-887d-44e19b8374e0',
});

roon.on('track', (zoneId, track) => {
  // fires on connect, whenever a zone's track changes, and whenever its heart / library state changes
  console.log(zoneId, track?.title, track?.favorite ? 'hearted' : 'not hearted');
});
roon.on('disconnected', (reason) => console.log('lost the Core', reason?.message));

await roon.connect();

const track = roon.trackForZone(zoneId);      // TrackInfo or null
await roon.setFavorite(zoneId, true);         // heart; adds a single track to the library first if needed
await roon.setFavorite(zoneId, false);        // un-heart
await roon.addToLibrary(zoneId, 'album');     // 'track' or 'album'
await roon.setAlbumFavorite(zoneId, true);    // heart the album (it must be in the library)

roon.close();
```

`setFavorite(zoneId, true, { addToLibrary: 'album' })` adds the whole album first instead of the single track; `{ addToLibrary: false }` throws `NotInLibraryError` instead of adding.

### TrackInfo

```ts
{
  zoneId: string,
  title: string,
  trackId: string | null,      // Roon's id for the track; changes when it is added to the library
  inLibrary: boolean,
  favorite: boolean,
  banned: boolean,
  source: 'local' | 'streaming' | null,
  album: { title, roonAlbumId, inLibrary, favorite } | null
}
```

### Errors

- `UnsupportedCoreError`: the Core turned us down. Wrong Core id, or a Roon version whose protocol this library doesn't speak. This is the one to catch to hide your heart button and tell the user "not supported with this Roon version".
- `NothingPlayingError`: the zone has nothing loaded (or the zone id is unknown).
- `NotInLibraryError`: you asked to heart without adding, and the track isn't in the library.
- `CallError`: the Core answered a call with a failure status.
- Plain `Error`: network trouble, timeouts, or the Core never confirming a change.

### Good to know

- Roon only hearts tracks that are in the library, which is why hearting adds first.
- Hearts are per Roon profile. The client uses the profile the Core hands it on connect.
- The Core keeps every object it has sent us for as long as the session lasts, and it sends a few for every track that plays. A long-running program should call `close()` and `connect()` again now and then (say once a day, or when `objectCount` gets large) so the Core can let go of them.
- Keep one connection per program; don't open a new one per button press.
- Everything happens on your own network, against your own Core, with no credentials involved. There is no authentication on this protocol locally, which is also why you should never expose port 9332 beyond your LAN.

## How it works, briefly

The Roon desktop app talks to the Core over a binary remoting protocol (`Sooloos.Broker.Remoting`) on TCP 9332. After a short handshake (the "server broker id" is just the Core id in .NET GUID byte order) the Core streams its object graph: zones, what they're playing, tracks and albums with their heart and library flags. Hearting is `Library::FavoriteOrBan` on the track object; adding is `Library::AddToLibrary`. The protocol was reverse-engineered by [Arthur Soares](https://github.com/arthursoares/roon-api-reverse-engineering); this package is a small, cleaned-up port of the parts needed for these features. Roon's CTO has [said](https://community.roonlabs.com/t/reverse-engineering-the-roon-desktop-clients-local-protocol-typescript-client-docs/321731) they don't mind interoperability tinkering against your own Core, and also that the protocol is internal, changes freely, and isn't hardened for third parties. Read that before building on this.

## Developing

```
npm install
npm test        # compiles and runs the unit tests (they use bytes captured from a real Core)
ROON_HOST=192.168.0.68 ROON_CORE_ID=<your core id> npm run example
```

The example lists every zone's track with its state and then watches for changes; `node dist/examples/heart-now-playing.js heart <zoneId>` hearts what that zone is playing (`unheart`, `add <zoneId> track|album`, `heartalbum`, `unheartalbum` likewise).

## License

MIT. Portions ported from [roon-api-reverse-engineering](https://github.com/arthursoares/roon-api-reverse-engineering) by Arthur Soares, also MIT; see NOTICE. Roon is a trademark of Roon Labs LLC.
