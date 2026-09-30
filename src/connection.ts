// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).
// Ported from arthursoares/roon-api-reverse-engineering (MIT), see NOTICE.

/**
 * The TCP connection to the Core and the handshake that turns it into a
 * remoting session:
 *
 *   1. TCP connect to <core>:9332
 *   2. -> "ROON" 01 04  <server broker id, 16 bytes>  <our random client id, 16 bytes>
 *   3. <- "ROON" 01 80  (ok)      or  "ROON" 01 81 (wrong server id) and the Core hangs up
 *   4. -> "ROON" 01 02
 *   5. <- "ROON" 01 82  <session id, 16 bytes>
 *   6. -> ConnectRequest (a SENDMSG frame the official client sends; we reuse
 *         its bytes with our client id patched in)
 *   7. <- ConnectResponse, and from here on everything is remoting frames
 *
 * The server broker id is the Core id every Roon client already knows (SOOD
 * discovery's unique_id, the extension API's core_id), written in .NET
 * Guid byte order. There is no authentication on the local network.
 */
import * as crypto from 'crypto';
import * as net from 'net';
import { Transport } from './remoting';

export const DEFAULT_PORT = 9332;

const MAGIC = Buffer.from('ROON');

/**
 * The ConnectRequest the Roon desktop client (protocol version 28, production
 * branch) sends after the handshake, captured by the upstream project. The
 * client broker id inside it is replaced with ours before sending.
 */
const CONNECT_REQUEST_TEMPLATE =
  '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964' +
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' +
  '228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

/** The Core turned us down: wrong Core id, or a Roon version whose protocol we don't speak. */
export class UnsupportedCoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCoreError';
  }
}

/**
 * The 16 bytes the handshake wants for a Core id such as
 * "fafb763c-9ad0-4f07-887d-44e19b8374e0": .NET's Guid.ToByteArray() order,
 * i.e. the first three groups byte-reversed and the last two as written.
 */
export function brokerIdFromCoreId(coreId: string): Buffer {
  const hex = coreId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`not a Core id: "${coreId}"`);
  const b = Buffer.from(hex, 'hex');
  return Buffer.concat([
    b.subarray(0, 4).reverse(),
    b.subarray(4, 6).reverse(),
    b.subarray(6, 8).reverse(),
    b.subarray(8, 16),
  ]);
}

export interface ConnectionOptions {
  host: string;
  port?: number;
  /** The Core id (GUID string) or the raw 16-byte broker id. */
  coreId: string | Buffer;
  /** How long the whole handshake may take. Default 10 s. */
  handshakeTimeoutMs?: number;
}

export class RoonConnection implements Transport {
  private socket: net.Socket | null = null;
  private dataHandler: (chunk: Buffer) => void = () => {};
  private established = false;
  private closed = false;
  readonly clientBrokerId = crypto.randomBytes(16);

  /** Called once when the connection ends, for whatever reason, after connect() resolved. */
  onClose: (reason: Error | null) => void = () => {};

  constructor(private readonly opts: ConnectionOptions) {}

  onData(handler: (chunk: Buffer) => void): void {
    this.dataHandler = handler;
  }

  send(data: Buffer): void {
    if (!this.socket || this.closed) throw new Error('not connected to the Core');
    this.socket.write(data);
  }

  get isOpen(): boolean {
    return this.established && !this.closed;
  }

  /** TCP connect + handshake + ConnectRequest. Resolves once remoting frames flow. */
  connect(): Promise<void> {
    const { host, port = DEFAULT_PORT } = this.opts;
    const serverBrokerId = Buffer.isBuffer(this.opts.coreId)
      ? this.opts.coreId
      : brokerIdFromCoreId(this.opts.coreId);
    if (serverBrokerId.length !== 16) throw new Error('the broker id must be 16 bytes');

    return new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15000);
      let step = 0;
      let done = false;

      const fail = (e: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        this.closed = true;
        reject(e);
      };
      const timer = setTimeout(
        () => fail(new UnsupportedCoreError(`the Core at ${host}:${port} did not finish the handshake in time`)),
        this.opts.handshakeTimeoutMs ?? 10000
      );

      socket.on('error', (e) => {
        if (this.established) this.finish(e);
        else fail(e);
      });
      socket.on('close', () => {
        if (this.established) {
          this.finish(null);
        } else if (!done) {
          const where =
            step === 1
              ? 'rejected our hello (wrong Core id?)'
              : step === 3
                ? 'rejected the connection request (unsupported Roon version?)'
                : 'closed the connection during the handshake';
          fail(new UnsupportedCoreError(`the Core at ${host}:${port} ${where}`));
        }
      });

      socket.on('connect', () => {
        step = 1;
        socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), serverBrokerId, this.clientBrokerId]));
      });

      socket.on('data', (data: Buffer) => {
        if (this.established) {
          this.dataHandler(data);
          return;
        }
        if (data.length >= 6 && data.subarray(0, 4).equals(MAGIC)) {
          const code = data[5];
          if (step === 1 && code === 0x80) {
            step = 2;
            socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
            return;
          }
          if (step === 1 && code === 0x81) {
            fail(new UnsupportedCoreError(`the Core at ${host}:${port} rejected our hello: the Core id does not match`));
            return;
          }
          if (step === 2 && code === 0x82) {
            step = 3;
            const request = Buffer.from(
              CONNECT_REQUEST_TEMPLATE.replace('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', this.clientBrokerId.toString('hex')),
              'hex'
            );
            socket.write(request);
            return;
          }
          fail(new UnsupportedCoreError(`unexpected handshake reply ${data.subarray(4, 6).toString('hex')} at step ${step}`));
          return;
        }
        if (step === 3) {
          // The first non-ROON bytes are the ConnectResponse: remoting is live.
          done = true;
          clearTimeout(timer);
          this.established = true;
          resolve();
          this.dataHandler(data);
          return;
        }
        fail(new UnsupportedCoreError(`unexpected bytes from the Core during the handshake (step ${step})`));
      });

      socket.connect(port, host);
    });
  }

  private finish(reason: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    const handler = this.onClose;
    this.onClose = () => {};
    handler(reason);
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners('close');
      socket.destroy();
    }
    this.finish(null);
  }
}
