// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).
// Ported from arthursoares/roon-api-reverse-engineering (MIT), see NOTICE.

/**
 * Variable-length integers, as used everywhere in Roon's remoting protocol.
 *
 * Big-endian base-128: 7 bits per byte, most significant group first, with the
 * 0x80 continuation bit set on every byte except the last.
 *
 *   143 => 81 0f   ((1 << 7) | 15)
 *
 * "flexInt" is 32-bit (lengths, method ids, type ids, enum values). Negative
 * values are written as their unsigned 32-bit bit pattern, so the -1 "null"
 * length sentinel is 0xFFFFFFFF (five bytes). "flexLong" is 64-bit (object ids)
 * and uses BigInt so nothing is lost past 2^53.
 */

export function writeFlexInt(out: number[], value: number): void {
  const u = value >>> 0;
  if (u <= 0x7f) {
    out.push(u);
  } else if (u <= 0x3fff) {
    out.push(0x80 | (u >>> 7), u & 0x7f);
  } else if (u <= 0x1fffff) {
    out.push(0x80 | (u >>> 14), 0x80 | ((u >>> 7) & 0x7f), u & 0x7f);
  } else if (u <= 0xfffffff) {
    out.push(0x80 | (u >>> 21), 0x80 | ((u >>> 14) & 0x7f), 0x80 | ((u >>> 7) & 0x7f), u & 0x7f);
  } else {
    out.push(
      0x80 | (u >>> 28),
      0x80 | ((u >>> 21) & 0x7f),
      0x80 | ((u >>> 14) & 0x7f),
      0x80 | ((u >>> 7) & 0x7f),
      u & 0x7f
    );
  }
}

/** Reads a flexInt at `pos`. Returns the value and the position after it. */
export function readFlexInt(buf: Uint8Array, pos: number): [number, number] {
  let num = 0;
  for (;;) {
    if (pos >= buf.length) throw new RangeError('flexInt runs past the end of the buffer');
    const b = buf[pos++];
    num = (num << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return [num >>> 0, pos];
}

export function writeFlexLong(out: number[], value: bigint | number): void {
  let u = BigInt(value) & 0xffffffffffffffffn;
  if (u === 0n) {
    out.push(0);
    return;
  }
  const groups: number[] = [];
  while (u > 0n) {
    groups.push(Number(u & 0x7fn));
    u >>= 7n;
  }
  groups.reverse();
  for (let i = 0; i < groups.length; i++) {
    out.push(i === groups.length - 1 ? groups[i] : 0x80 | groups[i]);
  }
}

/** Reads a flexLong at `pos`. Returns the value and the position after it. */
export function readFlexLong(buf: Uint8Array, pos: number): [bigint, number] {
  let num = 0n;
  for (;;) {
    if (pos >= buf.length) throw new RangeError('flexLong runs past the end of the buffer');
    const b = buf[pos++];
    num = (num << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return [num, pos];
}
