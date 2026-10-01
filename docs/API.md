# roon-library-controls API

## Overview

roon-library-controls is a small Node.js library that hearts the track a Roon zone is playing and adds it, or its album, to the Roon library. Roon's official extension API can't do either; this library talks to the Core the way Roon's own desktop app does, over the internal protocol on TCP port 9332.

It is meant to sit next to the official API, not replace it. You keep using `node-roon-api` for discovery, pairing, transport and browsing, and hand this library the Core's address and id. Zone ids are the same strings in both.

**What it does**

- Reports what each zone is playing with its heart and in-library state, live. The Core pushes changes, including hearts set in Roon itself.
- Hearts and un-hearts the playing track.
- Adds the playing track to the library, on its own or as its whole album.
- Hearts and un-hearts the playing track's album.

**What it doesn't do, on purpose**

- No banning, no removing from the library, no deleting. Nothing it does loses data.
- No playback control or browsing. The official API covers those.

**Unofficial, unsupported and experimental. Read [the warning in the README](../README.md#read-this-first) before you use this.** In short: Brian Luczkiewicz of Roon Labs, Roon Labs founder, has said [in the forum thread this work builds on](https://community.roonlabs.com/t/reverse-engineering-the-roon-desktop-clients-local-protocol-typescript-client-docs/321731) that the protocol is "engineered as an internal interface to be used by trusted code, and is not hardened for 3rd party use," that Roon changes it freely, and that misuse of it can easily cause memory or compute leaks in the Core. Any Roon update can break this library without warning, and careless use can hurt your Core. It is tested on Roon 2.73 and nothing else. Treat it as an optional feature in your app: catch `UnsupportedCoreError`, hide the controls when it fires, and give your users a switch to turn the feature off.

Requirements: Node 18 or newer, no dependencies. MIT licensed. Not affiliated with or endorsed by Roon Labs.

## Install and quick start

The package is published on GitHub, not npm, so install it from the repository:

```
npm install github:Vulkandr/roon-library-controls
```

It builds itself on install (TypeScript, with type definitions included). Node 18 or newer.

A complete program that connects, prints what every zone is playing, and hearts the track in one zone:

```js
const { RoonLibraryClient, UnsupportedCoreError } = require('roon-library-controls');

const roon = new RoonLibraryClient({
  host: '192.168.0.68',
  coreId: 'fafb763c-9ad0-4f07-887d-44e19b8374e0',
});

// Fires once per zone after connect, then whenever a zone's track or its
// heart / library state changes. `track` is null when nothing is loaded.
roon.on('track', (zoneId, track) => {
  if (!track) return console.log(zoneId, 'nothing loaded');
  console.log(zoneId, track.title, track.inLibrary ? 'in library' : 'not in library', track.favorite ? 'hearted' : '');
});

roon.on('disconnected', (reason) => console.log('lost the Core:', reason?.message ?? 'closed'));

async function main() {
  try {
    await roon.connect();
  } catch (err) {
    if (err instanceof UnsupportedCoreError) {
      console.log('This Roon version is not supported:', err.message);
      return; // hide your heart controls here
    }
    throw err; // network trouble: retry later
  }

  const zoneId = '16014dd0a6b8a1f4f3b2d7c8e9a0b1c2'; // from the extension API
  const track = roon.trackForZone(zoneId);
  if (track) {
    const after = await roon.setFavorite(zoneId, true); // adds to the library first if needed
    console.log('hearted:', after.title);
  }

  roon.close();
}

main();
```

TypeScript and ES modules work the same way:

```ts
import { RoonLibraryClient, type TrackInfo } from 'roon-library-controls';
```

## Finding the Core

The client needs two things: the Core's IP address or hostname, and its Core id, a GUID like `fafb763c-9ad0-4f07-887d-44e19b8374e0`. Every Roon extension already has both.

**From the official extension API.** When your extension pairs, the `core_paired` callback gives you a core object with `core_id` and the connection details:

```js
const roon = new RoonApi({
  // ...
  core_paired: (core) => {
    const host = core.moo.transport.host; // the Core's address
    const coreId = core.core_id;
    library = new RoonLibraryClient({ host, coreId });
    library.connect().catch(/* see Errors */);
  },
  core_unpaired: () => library?.close(),
});
```

**From SOOD discovery.** Discovery replies carry the Core's address and `unique_id`; that `unique_id` is the Core id.

**By hand.** Roon's Settings, About page shows the Core's address. The id is harder to find by hand, so take it from one of the two routes above.

The Core id matters: the connection handshake sends it (in .NET GUID byte order, which the library handles), and a Core that is sent the wrong id closes the connection, which surfaces as `UnsupportedCoreError`. If you switch Cores, close the client and make a new one with the new host and id.

The port is 9332 unless you changed it (`DEFAULT_PORT` is exported). The protocol has no authentication, which is fine on your own LAN and exactly why you should never expose that port beyond it.

## API reference

Everything is exported from the package root. The class is `RoonLibraryClient`; the rest are types and errors.

### new RoonLibraryClient(options)

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `host` | string | required | The Core's address. |
| `coreId` | string | required | The Core id GUID (see Finding the Core). |
| `port` | number | 9332 | The internal protocol's port. |
| `settleMs` | number | 3000 | How long to let the Core stream its objects after the handshake before `connect()` resolves. |
| `requestTimeoutMs` | number | 15000 | How long a call may wait for the Core's answer before failing. |
| `confirmTimeoutMs` | number | 8000 | How long to wait for the Core to confirm a heart or add before giving up. |
| `log` | (message: string) => void | silent | Receives debug lines (connection, calls, confirmations). |

The client is an `EventEmitter`. Make one per program and keep it; don't open a connection per button press.

### Methods

**`connect(): Promise<void>`**
Opens the connection, performs the handshake, and waits `settleMs` for the Core's objects. Resolves once the Library service and your profile have arrived, then emits `connected` and one `track` event per zone. Rejects with `UnsupportedCoreError` when the Core turns the connection down or doesn't send what the library needs, and with a plain `Error` for network trouble. Calling it while already connected throws.

**`close(): void`**
Ends the session. Emits `disconnected` with a `null` reason. Safe to call at any time.

**`connected: boolean`** (property)
Whether the session is up.

**`objectCount: number`** (property)
How many objects the Core has pushed this session. It grows while music plays, so use it to decide when to reconnect (see Behavior notes).

**`zoneIds(): string[]`**
The zone ids the Core reports. These are the same strings the extension API uses as `zone_id`.

**`trackForZone(zoneId): TrackInfo | null`**
What the zone has loaded right now, with its heart and library state, read from the objects already received. Synchronous and cheap. Returns `null` when nothing is loaded or the zone id is unknown.

**`setFavorite(zoneId, favorite, options?): Promise<TrackInfo>`**
Hearts (`true`) or un-hearts (`false`) the track the zone has loaded. Roon only hearts library tracks, so when the track isn't in the library yet it is added first. `options.addToLibrary` controls how: `'track'` (the default) adds the single track, `'album'` adds the whole album, and `false` throws `NotInLibraryError` instead of adding. Un-hearting a track that isn't in the library does nothing. Resolves with the confirmed state once the Core pushes the change, or with the last known state if the confirmation times out.

**`addToLibrary(zoneId, mode?): Promise<TrackInfo>`**
Adds the loaded track to the library. `mode` is `'track'` (default) or `'album'`. Does nothing if the track is already in the library. Resolves once the Core confirms the track has a library id; rejects with an `Error` if that confirmation never arrives.

**`setAlbumFavorite(zoneId, favorite): Promise<TrackInfo>`**
Hearts or un-hearts the album of the loaded track. The album must already be in the library; otherwise `NotInLibraryError`. Resolves with the confirmed state.

### Events

| Event | Arguments | When |
| --- | --- | --- |
| `connected` | none | The session is up and the first objects have arrived. |
| `disconnected` | `reason: Error \| null` | The session ended. `null` means you called `close()`; an `Error` means the Core or the network dropped it. |
| `track` | `zoneId: string, track: TrackInfo \| null` | A zone's loaded track changed, or its heart or library state did. Fires once per zone right after connect. `null` means the zone has nothing loaded or went away. |

The `track` event is the live feed: hearts set in Roon's own apps, tracks added elsewhere, and track changes all arrive through it. Render your UI from it rather than polling.

### Types

```ts
type AddMode = 'track' | 'album';

interface TrackInfo {
  zoneId: string;
  title: string;
  trackId: string | null;         // Roon's id for the playing track object
  libraryTrackId: string | null;  // the library's id, once the track is in the library
  inLibrary: boolean;
  favorite: boolean;
  banned: boolean;                // read-only; this library never bans
  source: 'local' | 'streaming' | null;
  album: AlbumInfo | null;
}

interface AlbumInfo {
  title: string;
  roonAlbumId: string | null;
  inLibrary: boolean;
  favorite: boolean;
}
```

Ids are strings because they are 64-bit numbers in the protocol. Compare them, don't do arithmetic on them. `trackId` can change when a streaming track is added to the library, because the library makes its own track object; `libraryTrackId` is the stable one from then on.

### Errors

| Error | Thrown by | Meaning and what to do |
| --- | --- | --- |
| `UnsupportedCoreError` | `connect()`, occasionally the change methods | The Core turned the connection down, or didn't send the objects this library needs. Either the Core id is wrong or this Roon version changed the protocol. Catch it, hide your heart controls, and tell the user the feature isn't supported with their Roon version. Don't retry in a loop. |
| `NothingPlayingError` | `trackForZone` callers, every change method | The zone has nothing loaded, or the zone id is unknown. |
| `NotInLibraryError` | `setFavorite` with `addToLibrary: false`, `setAlbumFavorite` | The track or album isn't in the library and you asked not to add it. |
| `CallError` | the change methods | The Core answered a call with a failure status. `method` and `status` are on the error. |
| `Error` | anything | Network trouble, a timeout, or the Core never confirming a change. Retry later. |

All five are exported, so `instanceof` checks work.

### Other exports

- `DEFAULT_PORT` (9332).
- `brokerIdFromCoreId(coreId): Buffer`, the Core id in the byte order the handshake uses. You won't normally need it.
- `readState(value, profileId): boolean`, reads a per-profile heart or ban flag out of a raw object. Exposed for tests and tooling.

## Behavior notes

**Hearts live on library tracks.** Roon only hearts tracks that are in the library, which is why `setFavorite` adds first. A streaming track (TIDAL, Qobuz) is a metadata object with no heart of its own; once it's in the library, the Core has a separate library track object that carries the heart. The library fetches that object automatically and reads the heart from it, so `favorite` is correct for streaming tracks too. There can be a short moment right after adding where `inLibrary` is already true but the heart hasn't resolved yet; the next `track` event settles it.

**Hearts are per profile.** The client uses the profile the Core hands it on connect, which is the Core's active profile. There is no option to pick another.

**Confirmation, not optimism.** The change methods don't resolve when the Core accepts the call; they resolve when the Core pushes the new state back, so what you get is what Roon's own apps now show. If that push doesn't arrive within `confirmTimeoutMs`, `setFavorite` and `setAlbumFavorite` resolve with the last known state, and `addToLibrary` rejects. Rendering from the `track` event rather than from return values keeps your UI right in both cases.

**Keepalive.** The Core drops a session that is silent for about 30 seconds. The client pings every 10 seconds and answers the Core's pings, so an idle connection stays up on its own. You don't need to do anything.

**Reconnecting is yours.** The client never reconnects by itself. On `disconnected` with a non-null reason, make a new `RoonLibraryClient` and `connect()` again, with backoff (the Stream Deck plugin uses 5 s, 15 s, 60 s, then 5 min). A `connect()` that rejects with `UnsupportedCoreError` isn't worth retrying until the Core changes or your program restarts.

**Sessions grow.** The Core keeps every object it has sent you for as long as the session lasts, and sends a few for every track that plays. A long-running program should close and reconnect now and then, once a day or when `objectCount` gets large (tens of thousands), so the Core can let go of them. Each reconnect costs `settleMs` of waiting before the client is ready.

**Keep it on screen only when needed.** If the feature is behind a button or a setting, connect when it's turned on and close when it's off. Don't hold a session open in programs that never use it.

**One connection per program.** Each `RoonLibraryClient` is a full session on the Core. Share one across your whole app instead of creating one per key, window or request.

**Zone ids are case-insensitive** in the library's lookups, so the ids the extension API gives you can be passed as they are.

## Planned

These work in the Rust port used by Roon: Toasted and are candidates for a later version of this package. Nothing here is in the package today.

- **Artist discography.** The artist's albums as the Core knows them, including releases that aren't in the library, with their streaming versions.
- **Complete release track lists.** Every track of an album, not only the ones you own, each with its own heart and library state.
- **Album-level add and heart by album**, not only through the playing track.

If you need one of these, open an issue on the repository so it can be prioritized.

## Credits

The protocol was reverse-engineered by [Arthur Soares](https://github.com/arthursoares/roon-api-reverse-engineering); this package is a small, cleaned-up port of the parts needed for these features, MIT licensed, see NOTICE. Roon is a trademark of Roon Labs LLC.
