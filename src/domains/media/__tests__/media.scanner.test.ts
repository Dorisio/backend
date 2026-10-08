/**
 * Malware scanning (#64).
 *
 * The rule these tests defend: an upload is only ever `clean` because a scanner
 * said so. A scanner that is missing, misconfigured, or broken must produce a
 * refusal, never a pass.
 */
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import {
  ClamAvScanner,
  EicarScanner,
  FailClosedScanner,
  NoScanScanner,
  createMalwareScanner,
} from '../media.scanner';
import { EICAR_BYTES, PNG_BYTES } from './fakes';

describe('EicarScanner', () => {
  it('passes ordinary content', async () => {
    const result = await new EicarScanner().scan(PNG_BYTES);
    expect(result).toMatchObject({ clean: true, scanned: true, scanner: 'eicar' });
  });

  it('recognises the EICAR test file', async () => {
    const result = await new EicarScanner().scan(EICAR_BYTES);
    expect(result.clean).toBe(false);
    expect(result.signature).toContain('Eicar');
  });

  it('scans the same content whether it arrives as a buffer or a stream', async () => {
    const scanner = new EicarScanner();
    const fromBuffer = await scanner.scan(EICAR_BYTES);
    const fromStream = await scanner.scan(Readable.from([EICAR_BYTES]));
    expect(fromStream.clean).toBe(fromBuffer.clean);
  });
});

describe('FailClosedScanner', () => {
  it('refuses to scan at all rather than implying the content is clean', async () => {
    await expect(new FailClosedScanner().scan()).rejects.toThrow(/not configured/i);
  });
});

describe('NoScanScanner', () => {
  it('reports that it produced no verdict at all', async () => {
    const result = await NoScanScanner.scan(PNG_BYTES);
    expect(result).toMatchObject({ clean: true, scanned: false });
  });
});

describe('createMalwareScanner', () => {
  it('builds the scanner named by configuration', () => {
    expect(createMalwareScanner({ driver: 'eicar' })).toBeInstanceOf(EicarScanner);
    expect(createMalwareScanner({ driver: 'none' })).toBeInstanceOf(FailClosedScanner);
    expect(createMalwareScanner({ driver: 'clamav', clamav: { host: 'clamd', port: 3310 } })).toBeInstanceOf(
      ClamAvScanner
    );
  });

  it('fails closed when clamav is selected without a host', () => {
    expect(createMalwareScanner({ driver: 'clamav' })).toBeInstanceOf(FailClosedScanner);
  });
});

describe('ClamAvScanner', () => {
  it('reports an unreachable daemon as an error instead of a clean verdict', async () => {
    // Port 1 is not a clamd; the scanner must surface the failure.
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 200 });
    await expect(scanner.scan(PNG_BYTES)).rejects.toThrow();
  });
});
