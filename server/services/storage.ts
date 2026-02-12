import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { logger } from './logger.js';
import { nanoid } from 'nanoid';
import path from 'path';

const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: 'us-east-1',
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
  forcePathStyle: true, // Required for MinIO
});

const BUCKET = config.s3.bucket;

// MIME type → attachment type mapping
const MIME_TYPE_MAP: Record<string, string> = {
  'image/jpeg': 'photo',
  'image/png': 'photo',
  'image/gif': 'photo',
  'image/webp': 'photo',
  'image/svg+xml': 'photo',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'voice',
  'audio/ogg': 'voice',
  'audio/wav': 'voice',
  'audio/webm': 'voice',
};

export function getAttachmentType(mimeType: string): string {
  return MIME_TYPE_MAP[mimeType] || 'file';
}

export function generateStorageKey(filename: string): string {
  const ext = path.extname(filename);
  const id = nanoid(16);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
  return `uploads/${date}/${id}${ext}`;
}

export async function uploadFile(
  key: string,
  body: Buffer | Uint8Array | ReadableStream,
  contentType: string,
  size: number,
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentLength: size,
  }));
  logger.debug({ key, contentType, size }, 'File uploaded to S3');
}

export async function getSignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function getSignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 600,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function deleteFile(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  logger.debug({ key }, 'File deleted from S3');
}

export async function fileExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

// Max file sizes by type (in bytes)
export const MAX_FILE_SIZES: Record<string, number> = {
  photo: 10 * 1024 * 1024,    // 10 MB
  video: 50 * 1024 * 1024,    // 50 MB
  voice: 16 * 1024 * 1024,    // 16 MB
  file: 100 * 1024 * 1024,    // 100 MB
};
