import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ValidationError } from '../../utils/errors';

/** Hard limit mandated by #49: avatars must not exceed 5MB. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Fastify's default body limit is 1MB; a 5MB image expanded to a base64 data
 * URL is ~6.7MB, so the avatar route opts into a larger limit explicitly.
 */
export const AVATAR_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/** URL prefix the static file server exposes for stored avatars. */
export const AVATAR_URL_PREFIX = '/uploads/avatars';

// Only JPEG and PNG are accepted, and the payload must be a base64 data URL.
const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export interface DecodedAvatar {
  extension: string;
  bytes: Buffer;
}

/**
 * Validate a `data:image/...;base64,...` payload and decode it to bytes.
 *
 * Rejects anything that is not a JPEG/PNG data URL, anything that decodes to
 * zero bytes, and anything larger than {@link AVATAR_MAX_BYTES}.
 */
export const decodeAvatarDataUrl = (image: string): DecodedAvatar => {
  const match = DATA_URL_PATTERN.exec(image.trim());
  if (!match) {
    throw new ValidationError(
      'Avatar must be a base64 data URL of type image/jpeg or image/png'
    );
  }

  const mime = match[1];
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');

  if (bytes.length === 0) {
    throw new ValidationError('Avatar image is empty');
  }
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new ValidationError('Avatar image must be 5MB or smaller');
  }

  return { extension: EXTENSION_BY_MIME[mime] ?? 'png', bytes };
};

/**
 * Persist a validated avatar to local storage and return its public URL.
 *
 * Files live under `uploads/avatars` (relative to the process working
 * directory) and are served by the static file middleware at
 * {@link AVATAR_URL_PREFIX}. Filenames are generated server side from the user
 * id plus a random suffix, so a client can never influence the stored path.
 */
export const storeAvatar = async (
  userId: string,
  image: string,
  rootDir: string = join(process.cwd(), 'uploads', 'avatars')
): Promise<string> => {
  const { extension, bytes } = decodeAvatarDataUrl(image);

  await mkdir(rootDir, { recursive: true });

  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '');
  const filename = `${safeUserId}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
  await writeFile(join(rootDir, filename), bytes);

  return `${AVATAR_URL_PREFIX}/${filename}`;
};
