/**
 * Media storage adapters (#64).
 *
 * Two things matter here: the presigned URL has to be a real SigV4 query
 * signature (so a browser can PUT without credentials), and local storage must
 * never be able to write outside its configured root.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import {
  LocalMediaStorage,
  S3MediaStorage,
  buildCdnUrl,
  createMediaStorage,
} from '../media.storage';
import { collect } from '../media.scanner';

const s3Config = {
  bucket: 'tips-media',
  region: 'eu-west-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret-example',
};

const AT = new Date('2026-09-27T12:00:00.000Z');

describe('S3MediaStorage.presign', () => {
  it('builds a signed URL with the expected query parameters', () => {
    const storage = new S3MediaStorage(s3Config);
    const url = new URL(
      storage.presign({ method: 'PUT', key: 'media/user_1/media_1/original.png', ttlSeconds: 900, now: AT })
    );

    expect(url.host).toBe('tips-media.s3.eu-west-1.amazonaws.com');
    expect(url.pathname).toBe('/media/user_1/media_1/original.png');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAEXAMPLE/20260927/eu-west-1/s3/aws4_request'
    );
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260927T120000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same key, method and timestamp', () => {
    const storage = new S3MediaStorage(s3Config);
    const first = storage.presign({ method: 'PUT', key: 'a/b.png', ttlSeconds: 60, now: AT });
    const second = storage.presign({ method: 'PUT', key: 'a/b.png', ttlSeconds: 60, now: AT });
    expect(first).toBe(second);
  });

  it('signs a different key, method and expiry differently', () => {
    const storage = new S3MediaStorage(s3Config);
    const base = storage.presign({ method: 'GET', key: 'a/b.png', ttlSeconds: 60, now: AT });
    const signature = (url: string) => new URL(url).searchParams.get('X-Amz-Signature');

    expect(signature(storage.presign({ method: 'GET', key: 'a/c.png', ttlSeconds: 60, now: AT }))).not.toBe(
      signature(base)
    );
    expect(signature(storage.presign({ method: 'PUT', key: 'a/b.png', ttlSeconds: 60, now: AT }))).not.toBe(
      signature(base)
    );
    expect(signature(storage.presign({ method: 'GET', key: 'a/b.png', ttlSeconds: 120, now: AT }))).not.toBe(
      signature(base)
    );
  });

  it('caps the expiry at the SigV4 maximum', () => {
    const storage = new S3MediaStorage(s3Config);
    const url = new URL(storage.presign({ method: 'GET', key: 'a/b.png', ttlSeconds: 999_999, now: AT }));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('604800');
  });

  it('includes the session token when one is configured', () => {
    const storage = new S3MediaStorage({ ...s3Config, sessionToken: 'session-token' });
    const url = new URL(storage.presign({ method: 'GET', key: 'a/b.png', ttlSeconds: 60, now: AT }));
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('session-token');
  });

  it('keeps the bucket in the path for a custom endpoint', () => {
    const storage = new S3MediaStorage({ ...s3Config, endpoint: 'https://minio.test:9000', forcePathStyle: true });
    const url = new URL(storage.presign({ method: 'GET', key: 'a/b.png', ttlSeconds: 60, now: AT }));
    expect(url.host).toBe('minio.test:9000');
    expect(url.pathname).toBe('/tips-media/a/b.png');
  });

  it('refuses to be built without credentials', () => {
    expect(() => new S3MediaStorage({ ...s3Config, secretAccessKey: '' })).toThrow();
  });
});

describe('LocalMediaStorage', () => {
  const roots: string[] = [];

  const makeRoot = async (): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'media-storage-'));
    roots.push(root);
    return root;
  };

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('round trips an object', async () => {
    const storage = new LocalMediaStorage(await makeRoot());
    const body = Buffer.from('image bytes');

    await storage.putObject({ key: 'media/u/m/original.png', body, contentType: 'image/png' });

    expect(await storage.head('media/u/m/original.png')).toMatchObject({ sizeBytes: body.byteLength });
    const object = await storage.getObject('media/u/m/original.png');
    expect(await collect(object.body, 1024)).toEqual(body);
  });

  it('returns null from head for a key that is not there', async () => {
    const storage = new LocalMediaStorage(await makeRoot());
    expect(await storage.head('media/nope.png')).toBeNull();
  });

  it('deletes keys without failing on missing ones', async () => {
    const storage = new LocalMediaStorage(await makeRoot());
    await storage.putObject({ key: 'a/b.png', body: Buffer.from('x'), contentType: 'image/png' });

    await storage.delete(['a/b.png', 'a/missing.png']);

    expect(await storage.head('a/b.png')).toBeNull();
  });

  it('refuses a key that would escape the storage root', async () => {
    const storage = new LocalMediaStorage(await makeRoot());
    await expect(storage.putObject({ key: '../../etc/evil', body: Buffer.from('x'), contentType: 'text/plain' })).rejects.toThrow(
      /storage key/i
    );
    await expect(storage.getObject('../../etc/passwd')).rejects.toThrow(/storage key/i);
  });

  it('exposes a local upload target rather than a signed URL', async () => {
    const storage = new LocalMediaStorage(await makeRoot());
    const target = await storage.createUploadTarget({ key: 'a/b.png', contentType: 'image/png', ttlSeconds: 60 });
    expect(target.url).toBe('local://a/b.png');
    expect(target.headers['Content-Type']).toBe('image/png');
  });

  it('streams a stored object back as a readable', async () => {
    const storage = new LocalMediaStorage(await makeRoot());
    await storage.putObject({ key: 'a/b.png', body: Buffer.from('abc'), contentType: 'image/png' });
    const { body } = await storage.getObject('a/b.png');
    expect(body).toBeInstanceOf(Readable);
  });
});

describe('buildCdnUrl', () => {
  it('returns null when no CDN is configured', () => {
    expect(buildCdnUrl(undefined, 'media/a/b.png')).toBeNull();
    expect(buildCdnUrl('', 'media/a/b.png')).toBeNull();
  });

  it('joins the base URL and the key, encoding each segment', () => {
    expect(buildCdnUrl('https://cdn.test', 'media/u_1/m_1/original.png')).toBe(
      'https://cdn.test/media/u_1/m_1/original.png'
    );
    expect(buildCdnUrl('https://cdn.test/', 'media/a b.png')).toBe('https://cdn.test/media/a%20b.png');
  });
});

describe('createMediaStorage', () => {
  it('builds the driver named by configuration', () => {
    expect(createMediaStorage({ driver: 'local', localRoot: '/tmp/media' })).toBeInstanceOf(LocalMediaStorage);
    expect(createMediaStorage({ driver: 's3', s3: s3Config })).toBeInstanceOf(S3MediaStorage);
  });
});
