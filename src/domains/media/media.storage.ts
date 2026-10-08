/**
 * Media storage (issue #64).
 *
 * Two adapters behind one interface: `S3MediaStorage` (presigned uploads, CDN
 * compatible, no SDK dependency — the SigV4 presignature is built with
 * `node:crypto`) and `LocalMediaStorage` for development and tests. The service
 * never talks to a bucket directly, so the API behaves the same either way.
 */

import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import axios from 'axios';
import { ServiceUnavailableError } from '../../utils/errors';

export interface UploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StoredObjectHead {
  sizeBytes: number;
  contentType?: string;
}

export interface ObjectBody {
  body: Readable;
  sizeBytes: number;
}

export interface MediaStorage {
  readonly kind: 's3' | 'local';
  createUploadTarget(input: { key: string; contentType: string; ttlSeconds: number }): Promise<UploadTarget>;
  createDownloadUrl(input: { key: string; ttlSeconds: number }): Promise<string>;
  head(key: string): Promise<StoredObjectHead | null>;
  getObject(key: string): Promise<ObjectBody>;
  putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

// ── S3 ──────────────────────────────────────────────────────────────────────

export interface S3StorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Custom endpoint (MinIO, R2, ...). Unset for AWS. */
  endpoint?: string;
  forcePathStyle?: boolean;
  requestTimeoutMs?: number;
}

const SHORT_DATE = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260927T133000Z
const DATE_STAMP = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, ''); // 20260927

/** `encodeURIComponent` per path segment; slashes survive. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class S3MediaStorage implements MediaStorage {
  readonly kind = 's3' as const;
  private readonly timeout: number;

  constructor(private readonly config: S3StorageConfig) {
    if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new ServiceUnavailableError('Object storage is not configured');
    }
    this.timeout = config.requestTimeoutMs ?? 15_000;
  }

  private get host(): string {
    if (this.config.endpoint) {
      return this.config.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
    return `${this.config.bucket}.s3.${this.config.region}.amazonaws.com`;
  }

  private get scheme(): string {
    if (this.config.endpoint) return this.config.endpoint.startsWith('http://') ? 'http' : 'https';
    return 'https';
  }

  /** Path part of the URL: path style keeps the bucket in the path. */
  private canonicalPath(key: string): string {
    const encoded = encodeKey(key);
    if (this.config.endpoint && this.config.forcePathStyle) return `/${this.config.bucket}/${encoded}`;
    if (this.config.endpoint) return `/${this.config.bucket}/${encoded}`;
    return `/${encoded}`;
  }

  /**
   * Builds a SigV4 query-signed URL. `UNSIGNED-PAYLOAD` is what the browser sends
   * when it PUTs to a presigned URL, so it is what goes into the canonical
   * request.
   */
  presign(input: { method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'; key: string; ttlSeconds: number; extraQuery?: Record<string, string>; now?: Date }): string {
    const now = input.now ?? new Date();
    const amzDate = SHORT_DATE(now);
    const dateStamp = DATE_STAMP(now);
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const host = this.host;
    const canonicalUri = this.canonicalPath(input.key);

    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(Math.max(1, Math.min(input.ttlSeconds, 604_800))),
      'X-Amz-SignedHeaders': 'host',
      ...(this.config.sessionToken ? { 'X-Amz-Security-Token': this.config.sessionToken } : {}),
      ...(input.extraQuery ?? {}),
    };

    const canonicalQueryString = Object.keys(query)
      .sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
      .join('&');

    const canonicalRequest = [
      input.method,
      canonicalUri,
      canonicalQueryString,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.config.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return `${this.scheme}://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  }

  async createUploadTarget(input: { key: string; contentType: string; ttlSeconds: number }): Promise<UploadTarget> {
    return {
      url: this.presign({ method: 'PUT', key: input.key, ttlSeconds: input.ttlSeconds }),
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
    };
  }

  async createDownloadUrl(input: { key: string; ttlSeconds: number }): Promise<string> {
    return this.presign({ method: 'GET', key: input.key, ttlSeconds: input.ttlSeconds });
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const url = this.presign({ method: 'HEAD', key, ttlSeconds: 300 });
    try {
      const response = await axios.head(url, { timeout: this.timeout, validateStatus: () => true });
      if (response.status === 404) return null;
      if (response.status >= 400) {
        throw new ServiceUnavailableError(`Object storage responded with ${response.status}`);
      }
      const length = Number(response.headers['content-length'] ?? 0);
      return {
        sizeBytes: Number.isFinite(length) ? length : 0,
        contentType: response.headers['content-type'],
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableError) throw error;
      throw new ServiceUnavailableError('Object storage is unreachable');
    }
  }

  async getObject(key: string): Promise<ObjectBody> {
    const url = this.presign({ method: 'GET', key, ttlSeconds: 300 });
    const response = await axios.get(url, { responseType: 'stream', timeout: this.timeout });
    const sizeBytes = Number(response.headers['content-length'] ?? 0);
    return { body: response.data as Readable, sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0 };
  }

  async putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    const url = this.presign({ method: 'PUT', key: input.key, ttlSeconds: 300 });
    await axios.put(url, input.body, {
      headers: { 'Content-Type': input.contentType, 'Content-Length': input.body.byteLength },
      timeout: this.timeout,
    });
  }

  async delete(keys: string[]): Promise<void> {
    await Promise.all(
      keys.map(async (key) => {
        const url = this.presign({ method: 'DELETE', key, ttlSeconds: 300 });
        await axios.delete(url, { timeout: this.timeout, validateStatus: () => true });
      })
    );
  }
}

// ── Local disk (development, tests) ─────────────────────────────────────────

export class LocalMediaStorage implements MediaStorage {
  readonly kind = 'local' as const;

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    // Keys are generated by the service, but a traversal must never escape root.
    if (!target.startsWith(path.resolve(this.root))) {
      throw new ServiceUnavailableError('Invalid storage key');
    }
    return target;
  }

  async createUploadTarget(input: { key: string; contentType: string; ttlSeconds: number }): Promise<UploadTarget> {
    return {
      url: `local://${input.key}`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
    };
  }

  async createDownloadUrl(input: { key: string; ttlSeconds: number }): Promise<string> {
    return `local://${input.key}`;
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    try {
      const info = await stat(this.resolve(key));
      return { sizeBytes: info.size };
    } catch {
      return null;
    }
  }

  async getObject(key: string): Promise<ObjectBody> {
    const target = this.resolve(key);
    const info = await stat(target);
    return { body: createReadStream(target), sizeBytes: info.size };
  }

  async putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    const target = this.resolve(input.key);
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(Readable.from(input.body), createWriteStream(target));
  }

  async delete(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => rm(this.resolve(key), { force: true })));
  }
}

// ── CDN + factory ───────────────────────────────────────────────────────────

/** CDN URL for a stored key, or `null` when no CDN is configured. */
export function buildCdnUrl(cdnBaseUrl: string | undefined, key: string): string | null {
  if (!cdnBaseUrl) return null;
  const base = cdnBaseUrl.replace(/\/$/, '');
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export interface MediaStorageSettings {
  driver: 's3' | 'local';
  cdnBaseUrl?: string;
  localRoot?: string;
  s3?: S3StorageConfig;
}

export function createMediaStorage(settings: MediaStorageSettings): MediaStorage {
  if (settings.driver === 's3') {
    return new S3MediaStorage(settings.s3 as S3StorageConfig);
  }
  return new LocalMediaStorage(settings.localRoot ?? path.join(process.cwd(), 'var/media'));
}
