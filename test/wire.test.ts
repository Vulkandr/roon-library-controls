// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFlexInt, readFlexLong, writeFlexInt, writeFlexLong } from '../src/flex';
import { BinaryReader, BinaryWriter } from '../src/wire';
import { FrameParser, encodeRequest, encodeResponse, Push } from '../src/frame';
import { ObjectGraph, PropertyType, field } from '../src/graph';
import { Arg, buildArgs } from '../src/args';
import { brokerIdFromCoreId } from '../src/connection';
import { readState } from '../src/client';
import { parseCallResult } from '../src/remoting';

const hex = (b: Uint8Array | number[]) => Buffer.from(b).toString('hex');

test('flexInt round-trips and matches Roon examples', () => {
  const cases: [number, string][] = [
    [0, '00'],
    [127, '7f'],
    [128, '8100'],
    [143, '810f'],
    [231, '8167'],
    [16383, 'ff7f'],
    [16384, '818000'],
    [3969842, '81f2a632'], // a library track id, as sent in PreviewDelete
    [-1, '8fffffff7f'],
  ];
  for (const [value, expected] of cases) {
    const out: number[] = [];
    writeFlexInt(out, value);
    assert.equal(hex(out), expected, `write ${value}`);
    const [back, pos] = readFlexInt(Buffer.from(expected, 'hex'), 0);
    assert.equal(back, value >>> 0, `read ${value}`);
    assert.equal(pos, expected.length / 2);
  }
});

test('flexLong round-trips object ids', () => {
  for (const value of [0n, 1n, 72n, 2417256n, 2555352n, 0xffffffffffffffffn]) {
    const out: number[] = [];
    writeFlexLong(out, value);
    const [back] = readFlexLong(Buffer.from(out), 0);
    assert.equal(back, value);
  }
  // Object id 2417245 as the Core wrote it in a DataList push
  const [oid] = readFlexLong(Buffer.from('8193c45d', 'hex'), 0);
  assert.equal(oid, 2417245n);
});

test('writer primitives', () => {
  assert.equal(hex(new BinaryWriter().string('en').toBuffer()), '02656e');
  assert.equal(hex(new BinaryWriter().string(null).toBuffer()), '8fffffff7f');
  assert.equal(hex(new BinaryWriter().boolean(true).boolean(false).toBuffer()), '0100');
  assert.equal(hex(new BinaryWriter().sooid(Buffer.from('3f01', 'hex')).toBuffer()), '023f01');
  const r = new BinaryReader(Buffer.from('02656e8fffffff7f', 'hex'));
  assert.equal(r.string(), 'en');
  assert.equal(r.string(), null);
  assert.equal(r.remaining, 0);
});

test('broker id is the Core id in .NET Guid byte order', () => {
  assert.equal(hex(brokerIdFromCoreId('fafb763c-9ad0-4f07-887d-44e19b8374e0')), '3c76fbfad09a074f887d44e19b8374e0');
  assert.equal(hex(brokerIdFromCoreId('FAFB763C9AD04F07887D44E19B8374E0')), '3c76fbfad09a074f887d44e19b8374e0');
  assert.throws(() => brokerIdFromCoreId('not-a-guid'));
});

test('frames: encode, parse, split and coalesced input', () => {
  const req = encodeRequest(3, Buffer.from([1, 2, 3]), 17);
  assert.equal(hex(req), '431103010203');
  const noReply = encodeRequest(6, Buffer.from([9]), null);
  assert.equal(hex(noReply), '060109');
  const resp = encodeResponse(17, Buffer.alloc(0));
  assert.equal(hex(resp), 'c01100');

  const parser = new FrameParser();
  const all = Buffer.concat([req, noReply, resp]);
  // feed one byte at a time
  const frames = [];
  for (const b of all) frames.push(...parser.push(Buffer.from([b])));
  assert.equal(frames.length, 3);
  assert.deepEqual([frames[0].cmd, frames[0].rid, frames[0].isResponse], [3, 17, false]);
  assert.equal(hex(frames[0].body), '010203');
  assert.deepEqual([frames[1].cmd, frames[1].rid], [6, null]);
  assert.deepEqual([frames[2].isResponse, frames[2].isFinal, frames[2].rid, frames[2].body.length], [true, true, 17, 0]);
  // all at once
  assert.equal(new FrameParser().push(all).length, 3);
});

test('call results: status string then payload', () => {
  const ok = parseCallResult(new BinaryWriter().string('Success').bytes([0xaa]).toBuffer());
  assert.deepEqual([ok.success, ok.status, hex(ok.payload)], [true, 'Success', 'aa']);
  const bad = parseCallResult(new BinaryWriter().string('MissingMethod').toBuffer());
  assert.deepEqual([bad.success, bad.status], [false, 'MissingMethod']);
});

test('args: the FavoriteOrBan block and a collection', () => {
  const profile = Buffer.from('3f019657409adb84814f872dab89ff0b7f2f', 'hex');
  const args = buildArgs([Arg.sooid(profile), Arg.ref(2375439n), Arg.enum(1)]);
  // Sooid(18 bytes) + flexLong(2375439) + enum(Favorite)
  assert.equal(hex(args), '12' + '3f019657409adb84814f872dab89ff0b7f2f' + '8190fe0f' + '01');
  // The IEnumerable<long> block sent to PreviewDelete for id 3969842, as captured
  const list = buildArgs([Arg.collection([new BinaryWriter().long(3969842).toBuffer()])]);
  assert.equal(hex(list), '050181f2a632');
});

test('object graph: types, sparse fields, lists, refs', () => {
  const g = new ObjectGraph();
  const deftype = (id: number, name: string, members: [string, PropertyType][]) => {
    const w = new BinaryWriter().flexInt(id).string(name).flexInt(members.length);
    for (const [n, t] of members) w.string(n).integer(t);
    g.ingest({ isResponse: false, cmd: Push.DEFTYPE, rid: null, isFinal: false, body: w.toBuffer() });
  };
  deftype(10, 'Sooloos.Broker.Api.TrackLite', [
    ['string Sooloos.Broker.Api.TrackLite::Title', PropertyType.String],
    ['long Sooloos.Broker.Api.TrackLite::LibraryTrackId', PropertyType.Long],
    ['Sooloos.Broker.Api.AlbumLite Sooloos.Broker.Api.TrackLite::Album', PropertyType.Object],
    ['System.Byte[] Sooloos.Broker.Api.TrackLite::IsFavorite', PropertyType.ByteArray],
  ]);
  deftype(574, 'Sooloos.Broker.Api.DataList<Sooloos.Broker.Api.Endpoint>', []); // 84 3e on the wire

  // A TrackLite with Title and Album set, LibraryTrackId left at default (absent)
  const body = new BinaryWriter()
    .long(2375439n)
    .flexInt(10)
    .flexInt(1)
    .string('Collapsing Skies')
    .flexInt(3)
    .long(34132n)
    .flexInt(4)
    .byteArray(Buffer.from('00', 'hex'))
    .flexInt(0)
    .toBuffer();
  let pushed: string[] = [];
  g.onObject = (_o, keys) => (pushed = keys);
  g.ingest({ isResponse: false, cmd: Push.PUSHOBJ, rid: null, isFinal: false, body });
  const track = g.getObject(2375439n)!;
  assert.equal(track.typeName, 'Sooloos.Broker.Api.TrackLite');
  assert.equal(field(track, 'Title'), 'Collapsing Skies');
  assert.equal(field(track, 'LibraryTrackId'), undefined);
  assert.deepEqual(field(track, 'Album'), { $ref: 34132n });
  assert.equal(pushed.length, 3);

  // An update that only carries IsFavorite
  const update = new BinaryWriter()
    .long(2375439n)
    .flexInt(10)
    .flexInt(4)
    .byteArray(Buffer.from('01123f019657409adb84814f872dab89ff0b7f2f01', 'hex'))
    .flexInt(0)
    .toBuffer();
  g.ingest({ isResponse: false, cmd: Push.UPDATEOBJ, rid: null, isFinal: false, body: update });
  assert.equal(field(track, 'Title'), 'Collapsing Skies');
  assert.equal(readState(field(track, 'IsFavorite'), Buffer.from('3f019657409adb84814f872dab89ff0b7f2f', 'hex')), true);
  assert.equal(readState(field(track, 'IsFavorite'), Buffer.from('aa', 'hex')), false);
  assert.equal(readState(Buffer.from('00', 'hex'), undefined), false);

  // DataList pushes exactly as the Core sent them
  for (const raw of ['8193c45d843e00', '8195c509843e038195c4358195c4538195c502']) {
    g.ingest({ isResponse: false, cmd: Push.PUSHOBJ, rid: null, isFinal: false, body: Buffer.from(raw, 'hex') });
  }
  assert.deepEqual(g.getObject(2417245n)!.items, []);
  assert.deepEqual(g.getObject(2450057n)!.items, [2449973n, 2450003n, 2450050n]);
});

test('return lists decode (PreviewDelete answer as captured)', () => {
  const g = new ObjectGraph();
  const w = new BinaryWriter().flexInt(216).string('Sooloos.Broker.Api.DeletePreview') /* 81 58 on the wire */.flexInt(3);
  w.string('Sooloos.Broker.Api.DeleteAction Sooloos.Broker.Api.DeletePreview::Action').integer(PropertyType.Enum);
  w.string('Sooloos.Broker.Api.TrackLite Sooloos.Broker.Api.DeletePreview::Track').integer(PropertyType.Object);
  w.string('Sooloos.Broker.Api.AlbumLite Sooloos.Broker.Api.DeletePreview::Album').integer(PropertyType.Object);
  g.ingest({ isResponse: false, cmd: Push.DEFTYPE, rid: null, isFinal: false, body: w.toBuffer() });
  const list = g.decodeReturnList(Buffer.from('0d0101815808010403819c975d00', 'hex')) as Record<string, unknown>[];
  assert.equal(list.length, 1);
  assert.equal(field(list[0] as never, 'Action'), 4);
  assert.deepEqual(field(list[0] as never, 'Album'), { $ref: 2558941n });
});
