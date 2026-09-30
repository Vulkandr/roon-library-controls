// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).
// Ported from arthursoares/roon-api-reverse-engineering (MIT), see NOTICE.

/**
 * The primitive encodings of Roon's remoting protocol (RemotingUtils in the
 * Roon client), as a growable writer and a cursor-based reader.
 *
 *   integer / flexInt   varint (see flex.ts); -1 is the "null" length
 *   long / flexLong     64-bit varint (object ids)
 *   boolean             one byte, 0 or 1
 *   string              integer(utf8 length) + bytes; null = integer(-1)
 *   sooid               integer(length) + raw bytes (Roon's opaque ids)
 *   guid                16 raw bytes in .NET Guid.ToByteArray() order
 *   double / float      little-endian IEEE-754
 *   byteArray           integer(length) + bytes; null = integer(-1)
 *   optional X          boolean(present) then X; optionalBoolean is 0/1/2(null)
 */
import { readFlexInt, readFlexLong, writeFlexInt, writeFlexLong } from './flex';

export class BinaryWriter {
  private out: number[] = [];

  get length(): number {
    return this.out.length;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.out);
  }

  bytes(b: Uint8Array | number[]): this {
    for (const x of b) this.out.push((x as number) & 0xff);
    return this;
  }

  byte(b: number): this {
    this.out.push(b & 0xff);
    return this;
  }

  integer(v: number): this {
    writeFlexInt(this.out, v);
    return this;
  }

  flexInt(v: number): this {
    writeFlexInt(this.out, v);
    return this;
  }

  long(v: bigint | number): this {
    writeFlexLong(this.out, v);
    return this;
  }

  boolean(v: boolean): this {
    this.out.push(v ? 1 : 0);
    return this;
  }

  string(v: string | null): this {
    if (v === null || v === undefined) return this.integer(-1);
    const utf8 = Buffer.from(v, 'utf8');
    this.integer(utf8.length);
    return this.bytes(utf8);
  }

  sooid(bytes: Uint8Array): this {
    this.integer(bytes.length);
    return this.bytes(bytes);
  }

  guid(guid16: Uint8Array): this {
    if (guid16.length !== 16) throw new Error('a guid is 16 bytes');
    return this.bytes(guid16);
  }

  double(v: number): this {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v, 0);
    return this.bytes(b);
  }

  float(v: number): this {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    return this.bytes(b);
  }

  byteArray(v: Uint8Array | null): this {
    if (v === null || v === undefined) return this.integer(-1);
    this.integer(v.length);
    return this.bytes(v);
  }
}

export class BinaryReader {
  pos = 0;

  constructor(public readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  flexInt(): number {
    const [v, pos] = readFlexInt(this.buf, this.pos);
    this.pos = pos;
    return v;
  }

  /** A flexInt read as a signed 32-bit number (0xFFFFFFFF is -1). */
  integer(): number {
    return this.flexInt() | 0;
  }

  flexLong(): bigint {
    const [v, pos] = readFlexLong(this.buf, this.pos);
    this.pos = pos;
    return v;
  }

  long(): bigint {
    return this.flexLong();
  }

  boolean(): boolean {
    return this.byte() !== 0;
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new RangeError('read past the end of the buffer');
    return this.buf[this.pos++];
  }

  bytes(n: number): Buffer {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new RangeError(`cannot read ${n} bytes, ${this.remaining} left`);
    }
    const b = Buffer.from(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return b;
  }

  guid(): Buffer {
    return this.bytes(16);
  }

  double(): number {
    return this.bytes(8).readDoubleLE(0);
  }

  float(): number {
    return this.bytes(4).readFloatLE(0);
  }

  char(): number {
    return this.integer();
  }

  /** .NET DateTime.ToBinary(); kept as the raw 64-bit value. */
  dateTime(): bigint {
    return this.long();
  }

  sooid(): Buffer {
    return this.bytes(this.integer());
  }

  string(): string | null {
    const len = this.integer();
    if (len < 0) return null;
    return this.bytes(len).toString('utf8');
  }

  byteArray(): Buffer | null {
    const len = this.integer();
    if (len < 0) return null;
    return this.bytes(len);
  }

  optionalInteger(): number | null {
    return this.boolean() ? this.integer() : null;
  }
  optionalLong(): bigint | null {
    return this.boolean() ? this.long() : null;
  }
  optionalBoolean(): boolean | null {
    const b = this.byte();
    return b === 0 ? false : b === 1 ? true : null;
  }
  optionalGuid(): Buffer | null {
    return this.boolean() ? this.guid() : null;
  }
  optionalSooid(): Buffer | null {
    const len = this.integer();
    return len < 0 ? null : this.bytes(len);
  }
  optionalDouble(): number | null {
    return this.boolean() ? this.double() : null;
  }
  optionalFloat(): number | null {
    return this.boolean() ? this.float() : null;
  }
  optionalChar(): number | null {
    return this.boolean() ? this.char() : null;
  }
  optionalDateTime(): bigint | null {
    return this.optionalLong();
  }
}
