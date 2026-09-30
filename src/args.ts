// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).
// Ported from arthursoares/roon-api-reverse-engineering (MIT), see NOTICE.

/**
 * Method arguments. A call's argument block is each parameter (except the
 * result callback, which travels as the request id) serialized in order:
 *
 *   Sooid            integer(len) + bytes
 *   object reference flexLong(object id); 0 = null
 *   enum             flexInt(value)
 *   primitives       as in wire.ts
 *   IEnumerable<T>   flexInt(byte length of the rest) + flexInt(count) + items,
 *                    where an item is a flexLong for plain values and an inline
 *                    value struct for struct types
 *   by-value struct  flexLong(1) + flexInt(client type id) + flexInt(len) + sparse fields
 */
import { PropertyType } from './graph';
import { BinaryWriter } from './wire';

export type Arg =
  | { kind: 'sooid'; value: Uint8Array }
  | { kind: 'ref'; oid: bigint | number }
  | { kind: 'collection'; elements: Buffer[] }
  | { kind: 'enum'; value: number }
  | { kind: 'str'; value: string | null }
  | { kind: 'bool'; value: boolean }
  | { kind: 'int'; value: number }
  | { kind: 'long'; value: bigint | number }
  | { kind: 'raw'; bytes: Buffer };

export const Arg = {
  sooid: (value: Uint8Array): Arg => ({ kind: 'sooid', value }),
  ref: (oid: bigint | number): Arg => ({ kind: 'ref', oid }),
  /** A length-prefixed collection of already-serialized elements. */
  collection: (elements: Buffer[]): Arg => ({ kind: 'collection', elements }),
  enum: (value: number): Arg => ({ kind: 'enum', value }),
  str: (value: string | null): Arg => ({ kind: 'str', value }),
  bool: (value: boolean): Arg => ({ kind: 'bool', value }),
  int: (value: number): Arg => ({ kind: 'int', value }),
  long: (value: bigint | number): Arg => ({ kind: 'long', value }),
  raw: (bytes: Buffer): Arg => ({ kind: 'raw', bytes }),
};

export function buildArgs(args: Arg[]): Buffer {
  const w = new BinaryWriter();
  for (const a of args) {
    switch (a.kind) {
      case 'sooid':
        w.sooid(a.value);
        break;
      case 'ref':
        w.long(a.oid);
        break;
      case 'collection': {
        const inner = new BinaryWriter().flexInt(a.elements.length);
        for (const e of a.elements) inner.bytes(e);
        const body = inner.toBuffer();
        w.flexInt(body.length).bytes(body);
        break;
      }
      case 'enum':
        w.flexInt(a.value);
        break;
      case 'str':
        w.string(a.value);
        break;
      case 'bool':
        w.boolean(a.value);
        break;
      case 'int':
        w.integer(a.value);
        break;
      case 'long':
        w.long(a.value);
        break;
      case 'raw':
        w.bytes(a.bytes);
        break;
    }
  }
  return w.toBuffer();
}

/** One member of a by-value struct we send: its full wire name and serialized value. */
export interface StructField {
  name: string;
  propType: PropertyType;
  value: Buffer;
}

/**
 * Serializes a by-value struct as an inline value object. `typeId` is the id
 * we declared for the type (RemotingClient.defineType). Members are matched by
 * name on the Core, in the order they were declared (1-based indexes here).
 */
export function inlineStruct(typeId: number, values: Buffer[]): Buffer {
  const fw = new BinaryWriter();
  values.forEach((v, i) => fw.flexInt(i + 1).bytes(v));
  fw.flexInt(0);
  const body = fw.toBuffer();
  return new BinaryWriter().long(1).flexInt(typeId).flexInt(body.length).bytes(body).toBuffer();
}
