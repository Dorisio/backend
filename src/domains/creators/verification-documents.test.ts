import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('creator verification document storage', () => {
  let storageRoot: string;
  let originalStoragePath: string | undefined;
  let storage: typeof import('./verification-documents');

  beforeEach(async () => {
    originalStoragePath = process.env.VERIFICATION_DOCUMENT_STORAGE_PATH;
    storageRoot = await mkdtemp(join(tmpdir(), 'creator-verification-'));
    process.env.VERIFICATION_DOCUMENT_STORAGE_PATH = storageRoot;
    vi.resetModules();
    storage = await import('./verification-documents');
  });

  afterEach(async () => {
    if (originalStoragePath === undefined) delete process.env.VERIFICATION_DOCUMENT_STORAGE_PATH;
    else process.env.VERIFICATION_DOCUMENT_STORAGE_PATH = originalStoragePath;
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('stores a document privately and returns its metadata and readable path', async () => {
    const contents = Buffer.from('identity proof');
    const [document] = await storage.storeVerificationDocuments('request-1', [{
      filename: '../identity.png',
      contentType: 'image/png',
      data: contents,
    }]);

    expect(document.filename).toBe('identity.png');
    expect(document.size).toBe(contents.length);
    expect(await readFile(storage.getVerificationDocumentPath(document.storageKey))).toEqual(contents);
  });

  it('rejects unsupported types, oversized files, and traversal keys', async () => {
    await expect(storage.storeVerificationDocuments('request-1', [{
      filename: 'id.txt', contentType: 'text/plain', data: Buffer.from('id'),
    }])).rejects.toThrow('PDF, JPEG, or PNG');

    await expect(storage.storeVerificationDocuments('request-2', [{
      filename: 'id.png', contentType: 'image/png', data: Buffer.alloc(10 * 1024 * 1024 + 1),
    }])).rejects.toThrow('between 1 byte and 10 MB');

    expect(() => storage.getVerificationDocumentPath('../outside.txt')).toThrow('Invalid verification document key');
  });
});