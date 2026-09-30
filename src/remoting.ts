// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).
// Ported from arthursoares/roon-api-reverse-engineering (MIT), see NOTICE.

/**
 * The remoting layer on top of a raw byte transport: method calls with
 * request/response matching, the one-time declarations the Core needs before
 * a call (DEFMETHOD for our method ids, DEFTYPE for structs we send), the
 * keep-alive replies, and the stream of pushes for the object graph.
 *
 * Method ids and type ids are ours to choose; the Core learns what they mean
 * from the declarations. Object ids are the Core's.
 */
import { Cmd, Frame, FrameParser, encodeRequest, encodeResponse } from './frame';
import { PropertyType } from './graph';
import { inlineStruct } from './args';
import { BinaryWriter, BinaryReader } from './wire';

export interface Transport {
  send(data: Buffer): void;
  onData(handler: (chunk: Buffer) => void): void;
}

export interface CallResult {
  /** The Core's status string; "Success" (or empty) means it worked. */
  status: string;
  success: boolean;
  /** The return value, if any: the bytes after the status. */
  payload: Buffer;
}

export class CallError extends Error {
  constructor(public readonly method: string, public readonly status: string) {
    super(`${method} failed: ${status || '(no status)'}`);
    this.name = 'CallError';
  }
}

interface Pending {
  chunks: Buffer[];
  resolve: (frame: Frame) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** How often an idle session is pinged: the Core drops one that has been silent for about 30 s. */
export const KEEPALIVE_MS = 10000;

export class RemotingClient {
  private readonly parser = new FrameParser();
  private keepalive: NodeJS.Timeout | null = null;
  // Starts past the request id the ConnectRequest used, so its late response can never be mistaken for ours.
  private ridCounter = 16;
  private readonly pending = new Map<number, Pending>();

  private readonly methodIds = new Map<string, number>();
  private nextMethodId = 1;

  private readonly typeIds = new Map<string, number>();
  private nextTypeId = 1;

  /** Every push from the Core (object graph frames, events, flushes). */
  onPush: (frame: Frame) => void = () => {};

  constructor(private readonly transport: Transport, private readonly requestTimeoutMs = 15000) {
    transport.onData((chunk) => {
      for (const frame of this.parser.push(chunk)) this.handleFrame(frame);
    });
    // Keepalive: the Core answers a PING with an empty response and keeps the
    // session open; without it an idle session (nothing playing, so nothing
    // to push) is dropped after about 30 s.
    this.keepalive = setInterval(() => {
      this.ping().catch(() => {});
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  /** A keepalive round trip. */
  ping(): Promise<void> {
    return this.request(Cmd.PING, Buffer.alloc(0)).then(() => undefined);
  }

  /** Fails every call still waiting and stops the keepalive (when the connection is gone). */
  abortPending(reason: Error): void {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    for (const [rid, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(rid);
      p.reject(reason);
    }
  }

  private nextRid(): number {
    this.ridCounter = (this.ridCounter + 1) & 0x7fffffff;
    return this.ridCounter;
  }

  /** Our id for a method signature, declaring it to the Core on first use. */
  methodId(signature: string): number {
    let id = this.methodIds.get(signature);
    if (id === undefined) {
      id = this.nextMethodId++;
      this.methodIds.set(signature, id);
      const body = new BinaryWriter().flexInt(id).string(signature).toBuffer();
      this.transport.send(encodeRequest(Cmd.DEFMETHOD, body, null));
    }
    return id;
  }

  /**
   * Our id for a by-value struct type, declaring it (with these members, in
   * this order) to the Core on first use. Use the same member list for a type
   * within one session.
   */
  defineType(typeName: string, members: { name: string; propType: PropertyType }[]): number {
    let id = this.typeIds.get(typeName);
    if (id === undefined) {
      id = this.nextTypeId++;
      this.typeIds.set(typeName, id);
      const w = new BinaryWriter().flexInt(id).string(typeName).flexInt(members.length);
      for (const m of members) w.string(m.name).integer(m.propType);
      this.transport.send(encodeRequest(Cmd.DEFTYPE, w.toBuffer(), null));
    }
    return id;
  }

  /** Serializes a by-value struct with the given members, declaring the type as needed. */
  struct(typeName: string, members: { name: string; propType: PropertyType; value: Buffer }[]): Buffer {
    const typeId = this.defineType(
      typeName,
      members.map((m) => ({ name: m.name, propType: m.propType }))
    );
    return inlineStruct(
      typeId,
      members.map((m) => m.value)
    );
  }

  /** Calls a method that has a result callback; resolves with the Core's answer. */
  async callMethod(objectId: bigint | number, signature: string, args: Buffer): Promise<CallResult> {
    const mid = this.methodId(signature);
    const body = new BinaryWriter().long(objectId).flexInt(mid).bytes(args).toBuffer();
    const frame = await this.request(Cmd.CALL, body);
    return parseCallResult(frame.body);
  }

  /** Calls a method without a result callback (the Core never answers). */
  callMethodNoReply(objectId: bigint | number, signature: string, args: Buffer): void {
    const mid = this.methodId(signature);
    const body = new BinaryWriter().long(objectId).flexInt(mid).bytes(args).toBuffer();
    this.transport.send(encodeRequest(Cmd.CALL, body, null));
  }

  /** Resolves a service GUID (16 bytes) to its object id. */
  async getService(guid16: Uint8Array): Promise<bigint> {
    const frame = await this.request(Cmd.GETSVC, new BinaryWriter().guid(guid16).toBuffer());
    const res = parseCallResult(frame.body);
    if (!res.success) throw new CallError('GETSVC', res.status);
    return new BinaryReader(res.payload).flexLong();
  }

  private request(cmd: number, body: Buffer): Promise<Frame> {
    const rid = this.nextRid();
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`the Core did not answer request ${rid} (cmd ${cmd}) within ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(rid, { chunks: [], resolve, reject, timer });
      this.transport.send(encodeRequest(cmd, body, rid));
    });
  }

  private handleFrame(frame: Frame): void {
    if (frame.isResponse) {
      const p = frame.rid !== null ? this.pending.get(frame.rid) : undefined;
      if (!p) return; // late or unknown
      p.chunks.push(frame.body);
      if (frame.isFinal) {
        clearTimeout(p.timer);
        this.pending.delete(frame.rid!);
        p.resolve({ ...frame, body: p.chunks.length === 1 ? frame.body : Buffer.concat(p.chunks) });
      }
      return;
    }
    if (frame.cmd === Cmd.PING) {
      if (frame.rid !== null) this.transport.send(encodeResponse(frame.rid, Buffer.alloc(0)));
      return;
    }
    this.onPush(frame);
    // Pushes that carry a request id want an acknowledgement.
    if (frame.rid !== null) this.transport.send(encodeResponse(frame.rid, Buffer.alloc(0)));
  }
}

/** A response body is a status string followed by the return value. */
export function parseCallResult(body: Buffer): CallResult {
  const r = new BinaryReader(body);
  const status = r.string() ?? '';
  return {
    status,
    success: status === 'Success' || status === '',
    payload: Buffer.from(body.subarray(r.pos)),
  };
}
