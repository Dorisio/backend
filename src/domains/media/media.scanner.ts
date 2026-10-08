/**
 * Upload scanning (issue #64).
 *
 * Every upload is scanned before it becomes `ready`. `ClamAvScanner` speaks
 * clamd's INSTREAM protocol over TCP (no dependency), and `EicarScanner` is the
 * development scanner: it detects the EICAR test signature so the pipeline can be
 * exercised without a daemon. Production without a configured scanner fails
 * closed — media is refused rather than stored unscanned.
 */

import net from 'node:net';
import { Readable } from 'node:stream';
import { ServiceUnavailableError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface ScanResult {
  clean: boolean;
  /** Virus name when the scan found something. */
  signature?: string;
  /** Which scanner produced this verdict; stored on the media row. */
  scanner: string;
  /** False when the scanner could not run (verdict unknown, never "clean"). */
  scanned: boolean;
}

export interface MalwareScanner {
  readonly name: string;
  scan(source: Buffer | Readable): Promise<ScanResult>;
}

/** The EICAR test string, split so this file does not look like a virus. */
export const EICAR_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const EICAR_MARKER = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

/**
 * Development scanner: recognises the EICAR test file and nothing else. It is
 * reported as `eicar` on the media row, so an upload scanned this way is never
 * mistaken for one that went through a real engine.
 */
export class EicarScanner implements MalwareScanner {
  readonly name = 'eicar';

  async scan(source: Buffer | Readable): Promise<ScanResult> {
    const buffer = Buffer.isBuffer(source) ? source : await collect(source, 2 * 1024 * 1024);
    const text = buffer.toString('latin1');
    if (text.includes(EICAR_MARKER)) {
      return { clean: false, signature: 'Eicar-Test-Signature', scanner: this.name, scanned: true };
    }
    return { clean: true, scanner: this.name, scanned: true };
  }
}

/** Fails closed: an unconfigured scanner must never report content as clean. */
export class FailClosedScanner implements MalwareScanner {
  readonly name = 'none';

  async scan(): Promise<ScanResult> {
    throw new ServiceUnavailableError('Virus scanning is not configured');
  }
}

export interface ClamAvOptions {
  host: string;
  port?: number;
  /** Ceiling for the whole stream, in bytes. */
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * clamd INSTREAM client. Writes `zINSTREAM\0`, then length-prefixed chunks, then
 * a zero-length chunk, and reads the null-terminated verdict.
 */
export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav';
  private readonly port: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: ClamAvOptions) {
    this.port = options.port ?? 3310;
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async scan(source: Buffer | Readable): Promise<ScanResult> {
    const stream = Buffer.isBuffer(source) ? Readable.from([source]) : source;

    return new Promise<ScanResult>((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.port });
      let response = '';
      let written = 0;
      let settled = false;

      const finish = (result: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.setTimeout(this.timeoutMs, () => fail(new ServiceUnavailableError('Virus scanner timed out')));

      socket.on('error', () => fail(new ServiceUnavailableError('Virus scanner is unreachable')));
      socket.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });
      socket.on('end', () => {
        const verdict = response.replace(/\0/g, '').trim();
        if (/FOUND$/.test(verdict)) {
          const signature = verdict.split(':').pop()?.replace(/\s*FOUND$/, '').trim() || 'unknown';
          finish({ clean: false, signature, scanner: this.name, scanned: true });
          return;
        }
        if (verdict.includes('OK')) {
          finish({ clean: true, scanner: this.name, scanned: true });
          return;
        }
        fail(new ServiceUnavailableError(`Virus scanner returned an unexpected verdict: ${verdict.slice(0, 120)}`));
      });

      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        stream.on('data', (chunk: Buffer) => {
          written += chunk.byteLength;
          if (written > this.maxBytes) {
            fail(new ServiceUnavailableError('Upload is too large to scan'));
            return;
          }
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.byteLength, 0);
          socket.write(length);
          socket.write(chunk);
        });
        stream.on('end', () => {
          socket.write(Buffer.from([0, 0, 0, 0]));
          socket.end();
        });
        stream.on('error', () => fail(new ServiceUnavailableError('Upload could not be read for scanning')));
      });
    });
  }
}

export async function collect(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new ServiceUnavailableError('Upload is too large to scan');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export interface ScannerSettings {
  driver: 'clamav' | 'eicar' | 'none';
  clamav?: ClamAvOptions;
}

/**
 * Scanner used by the processing worker. Scanning is part of the upload path, so
 * the worker must not re-scan (and must not claim a verdict it did not produce).
 */
export const NoScanScanner: MalwareScanner = {
  name: 'unscanned',
  async scan(): Promise<ScanResult> {
    return { clean: true, scanned: false, scanner: 'unscanned' };
  },
};

export function createMalwareScanner(settings: ScannerSettings): MalwareScanner {
  if (settings.driver === 'clamav') {
    if (!settings.clamav?.host) {
      logger.warn('MEDIA_SCANNER=clamav without CLAMAV_HOST: uploads will be refused');
      return new FailClosedScanner();
    }
    return new ClamAvScanner(settings.clamav);
  }
  if (settings.driver === 'eicar') return new EicarScanner();
  return new FailClosedScanner();
}
