// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).
// Ported from arthursoares/roon-api-reverse-engineering (MIT), see NOTICE.

/**
 * Remoting frames: how requests, responses and server pushes are packaged on
 * the TCP stream once the handshake is done.
 *
 *   [header byte] [flexInt requestId, sometimes] [flexInt bodyLength] [body]
 *
 *   header bit 0x80 clear: a REQUEST. Low 6 bits = command; bit 0x40 set means
 *     a response is expected and a request id follows.
 *   header bit 0x80 set: a RESPONSE. Bit 0x40 = this is the final chunk. A
 *     request id always follows.
 *
 * Commands we send: PING=1, GETSVC=2, CALL=3, DEFTYPE=5, DEFMETHOD=6, SENDMSG=7.
 * Pushes the Core sends us (same field, different meaning): EVENT=2, PUSHOBJ=3,
 * PUSHSTUB=4, UPDATEOBJ=5, FLUSH=6, DEFTYPE=7, DEFEVENT=8, FLUSHRESUME=9.
 */
import { writeFlexInt } from './flex';

export const Cmd = {
  PING: 1,
  GETSVC: 2,
  CALL: 3,
  GCOBJS: 4,
  DEFTYPE: 5,
  DEFMETHOD: 6,
  SENDMSG: 7,
} as const;

export const Push = {
  EVENT: 2,
  PUSHOBJ: 3,
  PUSHSTUB: 4,
  UPDATEOBJ: 5,
  FLUSH: 6,
  DEFTYPE: 7,
  DEFEVENT: 8,
  FLUSHRESUME: 9,
} as const;

export interface Frame {
  isResponse: boolean;
  /** The command (requests and pushes only). */
  cmd: number;
  /** Request id: on every response, and on requests that want one. */
  rid: number | null;
  /** Responses only: whether this is the last chunk. */
  isFinal: boolean;
  body: Buffer;
}

export function encodeRequest(cmd: number, body: Uint8Array, rid: number | null): Buffer {
  const out: number[] = [];
  if (rid !== null) {
    out.push((cmd & 0x3f) | 0x40);
    writeFlexInt(out, rid);
  } else {
    out.push(cmd & 0x3f);
  }
  writeFlexInt(out, body.length);
  return Buffer.concat([Buffer.from(out), Buffer.from(body)]);
}

export function encodeResponse(rid: number, body: Uint8Array, isFinal = true): Buffer {
  const out: number[] = [0x80 | (isFinal ? 0x40 : 0)];
  writeFlexInt(out, rid);
  writeFlexInt(out, body.length);
  return Buffer.concat([Buffer.from(out), Buffer.from(body)]);
}

/**
 * Turns socket chunks into complete frames. A frame may arrive split over
 * several reads, and one read may hold several frames.
 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.tryParseOne();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  /** Bytes waiting for the rest of a frame. */
  get buffered(): number {
    return this.buf.length;
  }

  private tryParseOne(): Frame | null {
    const u = this.buf;
    if (u.length < 2) return null;

    // A flexInt read that gives up instead of running past the buffer.
    const flex = (pos: number): [number, number] | null => {
      let num = 0;
      for (;;) {
        if (pos >= u.length) return null;
        const b = u[pos++];
        num = (num << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      return [num >>> 0, pos];
    };

    const header = u[0];
    const isResponse = (header & 0x80) !== 0;
    let pos = 1;
    let cmd = 0;
    let rid: number | null = null;
    let isFinal = false;

    if (isResponse) {
      isFinal = (header & 0x40) !== 0;
      const r = flex(pos);
      if (!r) return null;
      [rid, pos] = r;
    } else {
      cmd = header & 0x3f;
      if ((header & 0x40) !== 0) {
        const r = flex(pos);
        if (!r) return null;
        [rid, pos] = r;
      }
    }

    const len = flex(pos);
    if (!len) return null;
    const [bodyLen, bodyStart] = len;
    if (u.length < bodyStart + bodyLen) return null;

    const frame: Frame = {
      isResponse,
      cmd,
      rid,
      isFinal,
      body: Buffer.from(u.subarray(bodyStart, bodyStart + bodyLen)),
    };
    this.buf = this.buf.subarray(bodyStart + bodyLen);
    return frame;
  }
}
