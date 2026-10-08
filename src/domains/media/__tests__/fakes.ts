/**
 * In-memory collaborators for the media tests: a storage driver that keeps bytes
 * in a Map, a scanner with a scripted verdict, and a processor that returns
 * whatever renditions the test asks for.
 */
import { Readable } from 'node:stream';
import type { MediaStorage, ObjectBody, StoredObjectHead, UploadTarget } from '../media.storage';
import type { MalwareScanner, ScanResult } from '../media.scanner';
import type { MediaProcessor, ProcessingInput, ProcessingResult } from '../media.processor';

export class InMemoryStorage implements MediaStorage {
  readonly kind = 'local' as const;
  objects = new Map<string, { body: Buffer; contentType: string }>();
  deleted: string[] = [];

  async createUploadTarget(input: { key: string; contentType: string }): Promise<UploadTarget> {
    return {
      url: `https://storage.test/${input.key}`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    };
  }

  async createDownloadUrl(input: { key: string }): Promise<string> {
    return `https://storage.test/${input.key}?signed=1`;
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const object = this.objects.get(key);
    return object ? { sizeBytes: object.body.byteLength, contentType: object.contentType } : null;
  }

  async getObject(key: string): Promise<ObjectBody> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`Missing object ${key}`);
    return { body: Readable.from([object.body]), sizeBytes: object.body.byteLength };
  }

  async putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    this.objects.set(input.key, { body: input.body, contentType: input.contentType });
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(key);
      this.deleted.push(key);
    }
  }
}

export class StubScanner implements MalwareScanner {
  readonly name = 'stub';
  calls = 0;
  constructor(private readonly verdict: Partial<ScanResult> = {}) {}

  async scan(): Promise<ScanResult> {
    this.calls += 1;
    return { clean: true, scanned: true, scanner: this.name, ...this.verdict };
  }
}

export class ThrowingScanner implements MalwareScanner {
  readonly name = 'throwing';
  async scan(): Promise<ScanResult> {
    throw new Error('clamd unreachable');
  }
}

export class StubProcessor implements MediaProcessor {
  readonly name = 'stub';
  calls: ProcessingInput[] = [];
  constructor(
    private readonly result: Partial<ProcessingResult> = {}
  ) {}

  async process(input: ProcessingInput): Promise<ProcessingResult> {
    this.calls.push(input);
    return {
      status: 'done',
      processor: this.name,
      width: 800,
      height: 600,
      derivatives: [],
      ...this.result,
    };
  }
}

export class NoopProcessor implements MediaProcessor {
  readonly name = 'noop';
  async process(): Promise<ProcessingResult> {
    return { status: 'skipped', processor: this.name, error: 'nothing available', derivatives: [] };
  }
}

/** A 1x1 PNG: real magic bytes, so the `detectMimeType` gate passes. */
export const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex'
);

/** EICAR test file, split so this source file is not itself a virus sample. */
export const EICAR_BYTES = Buffer.from(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  'utf8'
);
