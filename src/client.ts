// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).

/**
 * RoonLibraryClient: heart the track a zone is playing, and add it (or its
 * album) to the library, over Roon's internal client protocol.
 *
 * Connect with the Core's address and id (both things every Roon extension
 * already has from discovery or pairing), then use the zone ids you already
 * know from the official extension API: they are the same strings.
 *
 *   const roon = new RoonLibraryClient({ host: '192.168.0.68', coreId: 'fafb763c-…' });
 *   roon.on('track', (zoneId, track) => console.log(zoneId, track?.title, track?.favorite));
 *   await roon.connect();
 *   await roon.setFavorite(zoneId, true);           // adds to the library first if needed
 *
 * What this can do is limited on purpose: read what is playing, heart it,
 * un-heart it, add it to the library. No banning, no removing, no deleting.
 */
import { EventEmitter } from 'events';
import { Arg, buildArgs } from './args';
import { RoonConnection, UnsupportedCoreError } from './connection';
import { ObjectGraph, PropertyType, RoonObject, field, isRef } from './graph';
import { CallError, RemotingClient } from './remoting';
import { BinaryReader, BinaryWriter } from './wire';

export interface LibraryClientOptions {
  /** The Core's address. */
  host: string;
  /** The internal protocol's port. Default 9332. */
  port?: number;
  /** The Core id, e.g. "fafb763c-9ad0-4f07-887d-44e19b8374e0" (SOOD unique_id / extension API core_id). */
  coreId: string;
  /** How long to give the Core to send its objects after connecting. Default 3000 ms. */
  settleMs?: number;
  /** How long a call may wait for the Core's answer. Default 15000 ms. */
  requestTimeoutMs?: number;
  /** How long to wait for the Core to confirm a change (heart, add). Default 8000 ms. */
  confirmTimeoutMs?: number;
  /** Where to send debug lines. Silent by default. */
  log?: (message: string) => void;
}

export type AddMode = 'track' | 'album';

export interface AlbumInfo {
  title: string;
  /** Roon's id for the album across the Core ("RoonAlbumId"), as a string. */
  roonAlbumId: string | null;
  inLibrary: boolean;
  favorite: boolean;
}

export interface TrackInfo {
  zoneId: string;
  title: string;
  /** Roon's id for the playing track object ("TrackId"), as a string. */
  trackId: string | null;
  /** The library's id for this track, once it is in the library. */
  libraryTrackId: string | null;
  inLibrary: boolean;
  favorite: boolean;
  banned: boolean;
  /** "local" for files, "streaming" for TIDAL/Qobuz/KKBOX, or null if unknown. */
  source: 'local' | 'streaming' | null;
  album: AlbumInfo | null;
}

export class NotInLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotInLibraryError';
  }
}

export class NothingPlayingError extends Error {
  constructor(zoneId: string) {
    super(`nothing is loaded in zone ${zoneId}`);
    this.name = 'NothingPlayingError';
  }
}

export interface LibraryClientEvents {
  connected: () => void;
  /** The session ended; `reason` is null for a deliberate close(). */
  disconnected: (reason: Error | null) => void;
  /** A zone's current track changed, or its heart / library state did. `track` is null when nothing is loaded. */
  track: (zoneId: string, track: TrackInfo | null) => void;
}

// The root service object every client asks for first; the Core answers by streaming its objects.
const ROOT_SERVICE_GUID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

// The exact method declarations, as the Roon client sends them.
const SIG = {
  favoriteTrack:
    'Sooloos.Broker.Api.Library::FavoriteOrBan(System.Sooid, Sooloos.Broker.Api.TrackBase, Sooloos.Broker.Api.FavoriteBanState, Base.ResultCallback)',
  favoriteAlbums:
    'Sooloos.Broker.Api.Library::FavoriteOrBan(System.Sooid, System.Collections.Generic.IEnumerable<Sooloos.Broker.Api.AlbumBase>, Sooloos.Broker.Api.FavoriteBanState, Base.ResultCallback)',
  addTrack: 'Sooloos.Broker.Api.Library::AddToLibrary(Sooloos.Broker.Api.Profile, Sooloos.Broker.Api.TrackBase)',
  addAlbum: 'Sooloos.Broker.Api.Library::AddToLibrary(Sooloos.Broker.Api.Profile, Sooloos.Broker.Api.AlbumBase)',
  getTrackLite: 'Sooloos.Broker.Api.Library::GetTrackLite(long, Base.ResultCallback<Sooloos.Broker.Api.TrackLite>)',
} as const;

const FAVORITE = 1;
const NOT_FAVORITE = 0;

// Types whose pushes can change what we report for a zone.
const WATCHED_TYPES = /\.(Zone|TransportItem|TransportTrack|TrackLite|AlbumLite|Profile)$|\.DataList<Sooloos\.Broker\.Api\.TransportTrack>$/;

export class RoonLibraryClient extends EventEmitter {
  private conn: RoonConnection | null = null;
  private remoting: RemotingClient | null = null;
  private graph = new ObjectGraph();
  private connectedFlag = false;
  private closing = false;

  private lastReported = new Map<string, string>(); // zoneId -> JSON of the last TrackInfo emitted
  // Streaming tracks come as "metadata" objects whose heart state never updates; the heart lives on
  // the library's own track object. LibraryTrackId -> that object's id, looked up via GetTrackLite.
  private libraryTracks = new Map<string, bigint>();
  private resolving = new Set<string>();
  private recomputeTimer: NodeJS.Timeout | null = null;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly opts: LibraryClientOptions) {
    super();
  }

  override on<E extends keyof LibraryClientEvents>(event: E, listener: LibraryClientEvents[E]): this {
    return super.on(event, listener);
  }
  override once<E extends keyof LibraryClientEvents>(event: E, listener: LibraryClientEvents[E]): this {
    return super.once(event, listener);
  }
  override off<E extends keyof LibraryClientEvents>(event: E, listener: LibraryClientEvents[E]): this {
    return super.off(event, listener);
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  /** How many objects the Core has pushed this session (grows while music plays). */
  get objectCount(): number {
    return this.graph.objects.size;
  }

  /**
   * Connects and waits for the Core's objects. Throws UnsupportedCoreError when
   * the Core turns us down (wrong id, or a Roon version we don't speak) and a
   * plain Error for network trouble.
   */
  async connect(): Promise<void> {
    if (this.conn) throw new Error('already connected (or connecting)');
    this.closing = false;
    this.graph = new ObjectGraph();
    this.lastReported.clear();
    this.libraryTracks.clear();
    this.resolving.clear();

    const conn = new RoonConnection({ host: this.opts.host, port: this.opts.port, coreId: this.opts.coreId });
    const remoting = new RemotingClient(conn, this.opts.requestTimeoutMs ?? 15000);
    remoting.onPush = (frame) => this.graph.ingest(frame);
    this.graph.onObject = (obj) => this.objectChanged(obj);
    this.conn = conn;
    this.remoting = remoting;

    conn.onClose = (reason) => this.lost(reason);

    try {
      await conn.connect();
      await remoting.getService(ROOT_SERVICE_GUID);
      await new Promise((r) => setTimeout(r, this.opts.settleMs ?? 3000));
      // Without these the protocol may have changed under us.
      if (!this.serviceOid('Library') || !this.profileObject()) {
        throw new UnsupportedCoreError('connected, but the Core did not send its Library and Profile objects');
      }
    } catch (e) {
      this.teardown();
      throw e;
    }

    this.connectedFlag = true;
    this.log(`connected to ${this.opts.host}, ${this.graph.objects.size} objects`);
    this.emit('connected');
    this.recompute();
  }

  /** Ends the session. */
  close(): void {
    this.closing = true;
    this.teardown();
  }

  private teardown(): void {
    const conn = this.conn;
    this.conn = null;
    const remoting = this.remoting;
    this.remoting = null;
    if (this.recomputeTimer) {
      clearTimeout(this.recomputeTimer);
      this.recomputeTimer = null;
    }
    remoting?.abortPending(new Error('connection closed'));
    if (conn) {
      conn.onClose = () => {};
      conn.close();
    }
    const wasConnected = this.connectedFlag;
    this.connectedFlag = false;
    for (const wake of this.waiters) wake();
    if (wasConnected) this.emit('disconnected', null);
  }

  private lost(reason: Error | null): void {
    if (this.closing) return;
    this.log(`connection lost: ${reason?.message ?? 'closed by the Core'}`);
    const wasConnected = this.connectedFlag;
    this.connectedFlag = false;
    this.conn = null;
    this.remoting?.abortPending(reason ?? new Error('connection closed by the Core'));
    this.remoting = null;
    for (const wake of this.waiters) wake();
    if (wasConnected) this.emit('disconnected', reason ?? new Error('connection closed by the Core'));
  }

  // --- reading ---

  /** The zone ids the Core reports (same strings as the extension API's zone_id). */
  zoneIds(): string[] {
    return this.graph.findByType('Zone').map((z) => zoneIdOf(z)).filter((id): id is string => id !== null);
  }

  /** What the zone has loaded right now, or null. */
  trackForZone(zoneId: string): TrackInfo | null {
    const track = this.trackObject(zoneId);
    return track ? this.describe(zoneId, track) : null;
  }

  private zoneObject(zoneId: string): RoonObject | undefined {
    const wanted = zoneId.toLowerCase();
    return this.graph.findByType('Zone').find((z) => zoneIdOf(z) === wanted);
  }

  /** Zone -> NowPlaying (TransportItem) -> Tracks (DataList) -> current TransportTrack -> Track (TrackLite). */
  private trackObject(zoneId: string): RoonObject | undefined {
    const zone = this.zoneObject(zoneId);
    if (!zone) return undefined;
    const item = this.graph.deref(field(zone, 'NowPlaying'));
    const list = this.graph.deref(field(item, 'Tracks'));
    if (!list?.items?.length) return undefined;
    const transportTracks = list.items.map((oid) => this.graph.getObject(oid)).filter((t): t is RoonObject => !!t);
    const current = transportTracks.find((t) => field<boolean>(t, 'IsCurrent') === true) ?? transportTracks[0];
    return this.graph.deref(field(current, 'Track'));
  }

  private describe(zoneId: string, track: RoonObject): TrackInfo {
    const profile = this.profileSooid();
    const albumObj = this.graph.deref(field(track, 'Album'));
    const source = field<number>(track, 'Source');
    const libraryTrackId = field(track, 'LibraryTrackId');
    // Heart and ban live on the library's track object (the same object for local files).
    const stateObj = this.libraryTrackObject(track) ?? track;
    return {
      zoneId,
      title: field<string>(track, 'Title') ?? '',
      trackId: idString(field(track, 'TrackId')),
      libraryTrackId: idString(libraryTrackId),
      inLibrary: libraryTrackId !== undefined,
      favorite: readState(field(stateObj, 'IsFavorite'), profile),
      banned: readState(field(stateObj, 'IsBanned'), profile),
      source: source === 1 ? 'local' : source === undefined ? null : 'streaming',
      album: albumObj
        ? {
            title: field<string>(albumObj, 'Title') ?? '',
            roonAlbumId: idString(field(albumObj, 'RoonAlbumId')),
            inLibrary: field(albumObj, 'LibraryAlbumId') !== undefined,
            favorite: readState(field(albumObj, 'IsFavorite'), profile),
          }
        : null,
    };
  }

  private serviceOid(name: string): bigint | undefined {
    return this.graph.findByType(name)[0]?.oid;
  }

  private profileObject(): RoonObject | undefined {
    return this.graph.findByType('Profile').find((p) => Buffer.isBuffer(field(p, 'ProfileId')));
  }

  private profileSooid(): Buffer | undefined {
    return field<Buffer>(this.profileObject(), 'ProfileId');
  }

  /**
   * The library's own object for a track, if we have it. Local tracks are their
   * own library object. Streaming tracks are "metadata" objects whose TrackId
   * differs from their LibraryTrackId; for those the library object is fetched
   * with GetTrackLite (see resolveLibraryTrack) and the Core keeps it updated.
   */
  private libraryTrackObject(track: RoonObject): RoonObject | undefined {
    const libraryId = field(track, 'LibraryTrackId');
    if (libraryId === undefined) return undefined;
    if (String(libraryId) === String(field(track, 'TrackId'))) return track;
    const oid = this.libraryTracks.get(String(libraryId));
    const obj = oid !== undefined ? this.graph.getObject(oid) : undefined;
    if (!obj) this.resolveLibraryTrack(String(libraryId));
    return obj;
  }

  /** Asks the Core for the library's track object; the answer lands in the graph and triggers a 'track' event. */
  private resolveLibraryTrack(libraryTrackId: string): void {
    if (this.resolving.has(libraryTrackId) || !this.remoting || !this.connectedFlag) return;
    const library = this.serviceOid('Library');
    if (library === undefined) return;
    this.resolving.add(libraryTrackId);
    this.remoting
      .callMethod(library, SIG.getTrackLite, buildArgs([Arg.long(BigInt(libraryTrackId))]))
      .then((res) => {
        if (!res.success || !res.payload.length) throw new CallError('GetTrackLite', res.status);
        const oid = new BinaryReader(res.payload).flexLong();
        this.libraryTracks.set(libraryTrackId, oid);
        this.log(`library track ${libraryTrackId} is object ${oid}`);
        // The object itself usually arrives right after; report either way.
        setTimeout(() => this.scheduleRecompute(), 300);
      })
      .catch((e: Error) => this.log(`GetTrackLite(${libraryTrackId}) failed: ${e.message}`))
      .finally(() => this.resolving.delete(libraryTrackId));
  }

  /** Waits for the library's track object (resolving it if needed), or gives up after the confirm timeout. */
  private async awaitLibraryTrack(zoneId: string): Promise<RoonObject> {
    const deadline = Date.now() + (this.opts.confirmTimeoutMs ?? 8000);
    for (;;) {
      const track = this.requireTrack(zoneId);
      const obj = this.libraryTrackObject(track);
      if (obj) return obj;
      if (Date.now() > deadline) throw new Error(`the Core did not provide the library object for "${field(track, 'Title')}"`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // --- changing ---

  /**
   * Hearts (or un-hearts) the track the zone has loaded. Roon only hearts
   * library tracks, so when the track isn't in the library yet it is added
   * first, as a single track or as its whole album (`addToLibrary`, default
   * "track"); pass `false` to get a NotInLibraryError instead.
   * Resolves with the confirmed state.
   */
  async setFavorite(
    zoneId: string,
    favorite: boolean,
    options: { addToLibrary?: AddMode | false } = {}
  ): Promise<TrackInfo> {
    let track = this.requireTrack(zoneId);
    if (!field(track, 'LibraryTrackId')) {
      if (!favorite) return this.describe(zoneId, track); // nothing to un-heart
      const mode = options.addToLibrary ?? 'track';
      if (mode === false) throw new NotInLibraryError(`"${field(track, 'Title')}" is not in the library`);
      await this.addToLibrary(zoneId, mode);
      track = this.requireTrack(zoneId);
    }

    const target = await this.awaitLibraryTrack(zoneId);
    const remoting = this.requireRemoting();
    const profile = this.profileSooid();
    const library = this.serviceOid('Library');
    if (!profile || library === undefined) throw new UnsupportedCoreError('no Library service or Profile in the graph');
    const before = this.describe(zoneId, track);
    if (before.favorite === favorite) return before;

    this.log(`${favorite ? 'heart' : 'un-heart'} "${before.title}"`);
    const result = await remoting.callMethod(
      library,
      SIG.favoriteTrack,
      buildArgs([Arg.sooid(profile), Arg.ref(target.oid), Arg.enum(favorite ? FAVORITE : NOT_FAVORITE)])
    );
    if (!result.success) throw new CallError('FavoriteOrBan', result.status);

    // The Core pushes the new IsFavorite onto the same object.
    const confirmed = await this.waitForTrack(zoneId, (t) => t.favorite === favorite);
    return confirmed ?? this.describe(zoneId, this.requireTrack(zoneId));
  }

  /**
   * Adds the loaded track (or its whole album) to the library. Roon's own
   * "+ Add to Library" adds the album; many people prefer that, others don't
   * want single songs in their library, so both are offered. Resolves once
   * the Core confirms the track is in the library.
   */
  async addToLibrary(zoneId: string, mode: AddMode = 'track'): Promise<TrackInfo> {
    const track = this.requireTrack(zoneId);
    const before = this.describe(zoneId, track);
    if (before.inLibrary) return before;

    const remoting = this.requireRemoting();
    const profile = this.profileObject();
    const library = this.serviceOid('Library');
    if (!profile || library === undefined) throw new UnsupportedCoreError('no Library service or Profile in the graph');

    if (mode === 'album') {
      const album = this.graph.deref(field(track, 'Album'));
      if (!album) throw new Error(`"${before.title}" has no album object to add`);
      this.log(`add album "${field(album, 'Title')}" to the library`);
      remoting.callMethodNoReply(library, SIG.addAlbum, buildArgs([Arg.ref(profile.oid), Arg.ref(album.oid)]));
    } else {
      this.log(`add track "${before.title}" to the library`);
      remoting.callMethodNoReply(library, SIG.addTrack, buildArgs([Arg.ref(profile.oid), Arg.ref(track.oid)]));
    }

    // No reply to this call; the Core confirms by pushing a LibraryTrackId.
    const confirmed = await this.waitForTrack(zoneId, (t) => t.inLibrary);
    if (!confirmed) throw new Error(`the Core did not confirm adding "${before.title}" to the library`);
    return confirmed;
  }

  /**
   * Hearts (or un-hearts) the album of the track the zone has loaded. The
   * album must already be in the library. Resolves with the confirmed state.
   */
  async setAlbumFavorite(zoneId: string, favorite: boolean): Promise<TrackInfo> {
    const track = this.requireTrack(zoneId);
    const album = this.graph.deref(field(track, 'Album'));
    if (!album) throw new Error('the track has no album object');
    if (field(album, 'LibraryAlbumId') === undefined) {
      throw new NotInLibraryError(`"${field(album, 'Title')}" is not in the library`);
    }
    const albumId = field<bigint>(album, 'AlbumId');
    if (albumId === undefined) throw new UnsupportedCoreError('the album object has no AlbumId');

    const remoting = this.requireRemoting();
    const profile = this.profileSooid();
    const library = this.serviceOid('Library');
    const broker = this.serviceOid('Broker');
    if (!profile || library === undefined || broker === undefined) {
      throw new UnsupportedCoreError('no Library/Broker service or Profile in the graph');
    }
    const before = this.describe(zoneId, track);
    if (before.album?.favorite === favorite) return before;

    // The official client sends the IEnumerable<AlbumBase> form with inline AlbumLink structs.
    const link = remoting.struct('Sooloos.Broker.Api.AlbumLink', [
      {
        name: 'long Sooloos.Broker.Api.AlbumLink::AlbumId',
        propType: PropertyType.Long,
        value: new BinaryWriter().long(albumId).toBuffer(),
      },
      {
        name: 'Sooloos.Broker.Api.Broker Sooloos.Broker.Api.AlbumLink::Broker',
        propType: PropertyType.Object,
        value: new BinaryWriter().long(broker).toBuffer(),
      },
    ]);
    this.log(`${favorite ? 'heart' : 'un-heart'} album "${before.album?.title}"`);
    const result = await remoting.callMethod(
      library,
      SIG.favoriteAlbums,
      buildArgs([Arg.sooid(profile), Arg.collection([link]), Arg.enum(favorite ? FAVORITE : NOT_FAVORITE)])
    );
    if (!result.success) throw new CallError('FavoriteOrBan(albums)', result.status);
    const confirmed = await this.waitForTrack(zoneId, (t) => t.album?.favorite === favorite);
    return confirmed ?? this.describe(zoneId, this.requireTrack(zoneId));
  }

  // --- internals ---

  private requireRemoting(): RemotingClient {
    if (!this.remoting || !this.connectedFlag) throw new Error('not connected to the Core');
    return this.remoting;
  }

  private requireTrack(zoneId: string): RoonObject {
    const track = this.trackObject(zoneId);
    if (!track) throw new NothingPlayingError(zoneId);
    return track;
  }

  private objectChanged(obj: RoonObject): void {
    if (!this.connectedFlag || !WATCHED_TYPES.test(obj.typeName)) return;
    for (const wake of this.waiters) wake();
    this.scheduleRecompute();
  }

  /** Pushes arrive in bursts; report once they settle. */
  private scheduleRecompute(): void {
    if (this.recomputeTimer || !this.connectedFlag) return;
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null;
      this.recompute();
    }, 60);
  }

  private recompute(): void {
    const seen = new Set<string>();
    for (const zoneId of this.zoneIds()) {
      seen.add(zoneId);
      const info = this.trackForZone(zoneId);
      const key = JSON.stringify(info);
      if (this.lastReported.get(zoneId) !== key) {
        this.lastReported.set(zoneId, key);
        this.emit('track', zoneId, info);
      }
    }
    for (const zoneId of [...this.lastReported.keys()]) {
      if (!seen.has(zoneId)) {
        this.lastReported.delete(zoneId);
        this.emit('track', zoneId, null);
      }
    }
  }

  /** Resolves with the zone's track once `predicate` holds, or null on timeout / disconnect. */
  private waitForTrack(zoneId: string, predicate: (t: TrackInfo) => boolean): Promise<TrackInfo | null> {
    const timeoutMs = this.opts.confirmTimeoutMs ?? 8000;
    return new Promise((resolve) => {
      let settled = false;
      const check = () => {
        if (settled) return;
        const info = this.connectedFlag ? this.trackForZone(zoneId) : null;
        if ((info && predicate(info)) || !this.connectedFlag) finish(info && predicate(info) ? info : null);
      };
      const finish = (value: TrackInfo | null) => {
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.waiters.add(check);
      check();
    });
  }
}

/** The zone id string (the extension API's zone_id) from a Zone object. */
function zoneIdOf(zone: RoonObject): string | null {
  const id = field(zone, 'ZoneId');
  return Buffer.isBuffer(id) ? id.toString('hex') : null;
}

function idString(v: unknown): string | null {
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  return null;
}

/**
 * IsFavorite / IsBanned are per-profile maps: flexInt(count), then for each
 * entry a Sooid (the profile) and a flexInt state (0 = none, 1 = set).
 * A bare 00 means nobody has set it.
 */
export function readState(raw: unknown, profile: Buffer | undefined): boolean {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return false;
  try {
    const r = new BinaryReader(raw);
    const count = r.flexInt();
    let anyone = false;
    for (let i = 0; i < count; i++) {
      const who = r.sooid();
      const state = r.flexInt();
      if (state === 1) {
        if (profile && who.equals(profile)) return true;
        anyone = true;
      }
    }
    return profile ? false : anyone;
  } catch {
    return false;
  }
}

export { isRef };
