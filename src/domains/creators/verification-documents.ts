import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/env';
import { ValidationError } from '../../utils/errors';

const MAX_DOCUMENTS = 5;
const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const STORAGE_ROOT = resolve(config.VERIFICATION_DOCUMENT_STORAGE_PATH);

export interface VerificationDocumentInput {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface StoredVerificationDocument {
  storageKey: string;
  filename: string;
  contentType: string;
  size: number;
}

export async function storeVerificationDocuments(
  requestId: string,
  documents: VerificationDocumentInput[]
): Promise<StoredVerificationDocument[]> {
  if (documents.length > MAX_DOCUMENTS) throw new ValidationError('At most five documents may be uploaded');
  const requestDirectory = join(STORAGE_ROOT, requestId);
  await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
  const stored: StoredVerificationDocument[] = [];

  try {
    for (const document of documents) {
      if (!ACCEPTED_TYPES.has(document.contentType)) throw new ValidationError('Documents must be PDF, JPEG, or PNG files');
      if (document.data.length === 0 || document.data.length > MAX_DOCUMENT_SIZE) {
        throw new ValidationError('Each verification document must be between 1 byte and 10 MB');
      }
      const key = `${randomUUID()}.${document.contentType === 'application/pdf' ? 'pdf' : document.contentType === 'image/png' ? 'png' : 'jpg'}`;
      const finalPath = join(requestDirectory, key);
      const temporaryPath = `${finalPath}.tmp`;
      const file = await open(temporaryPath, 'wx', 0o600);
      await file.writeFile(document.data);
      await file.close();
      await rename(temporaryPath, finalPath);
      stored.push({
        storageKey: `${requestId}/${key}`,
        filename: basename(document.filename).slice(0, 255),
        contentType: document.contentType,
        size: document.data.length,
      });
    }
    return stored;
  } catch (error) {
    await rm(requestDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function removeVerificationDocuments(requestId: string): Promise<void> {
  await rm(join(STORAGE_ROOT, requestId), { recursive: true, force: true });
}

export function getVerificationDocumentPath(storageKey: string): string {
  const resolvedPath = resolve(STORAGE_ROOT, storageKey);
  const relativePath = relative(STORAGE_ROOT, resolvedPath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new ValidationError('Invalid verification document key');
  }
  return resolvedPath;
}