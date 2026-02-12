import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, messages, conversationMembers } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  uploadFile,
  generateStorageKey,
  getAttachmentType,
  getSignedDownloadUrl,
  MAX_FILE_SIZES,
} from '../services/storage.js';
import { logger } from '../services/logger.js';

const uploadRouter = new Hono();

uploadRouter.use('*', authMiddleware);

// POST /api/upload — upload a file
// Expects multipart form data with 'file' field and optional 'message_id'
uploadRouter.post('/', async (c) => {
  const userId = c.get('userId');

  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'validation_error', message: 'No file provided' }, 400);
  }

  const mimeType = file.type || 'application/octet-stream';
  const attachmentType = getAttachmentType(mimeType);
  const maxSize = MAX_FILE_SIZES[attachmentType] || MAX_FILE_SIZES.file;

  if (file.size > maxSize) {
    return c.json({
      error: 'file_too_large',
      message: `File exceeds maximum size of ${Math.round(maxSize / 1024 / 1024)}MB`,
    }, 413);
  }

  const filename = file.name || 'unnamed';
  const storageKey = generateStorageKey(filename);

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await uploadFile(storageKey, buffer, mimeType, file.size);

    // If message_id is provided, create attachment record
    const messageId = typeof body['message_id'] === 'string' ? body['message_id'] : undefined;

    if (messageId) {
      const [msg] = await db.select({ id: messages.id, conversationId: messages.conversationId })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1);

      if (!msg) {
        return c.json({ error: 'not_found', message: 'Message not found' }, 404);
      }

      // Verify user is member of the conversation
      const [membership] = await db.select()
        .from(conversationMembers)
        .where(
          eq(conversationMembers.conversationId, msg.conversationId)
        )
        .limit(1);

      if (!membership) {
        return c.json({ error: 'forbidden', message: 'Not a member of the conversation' }, 403);
      }

      const [attachment] = await db.insert(attachments).values({
        messageId,
        type: attachmentType,
        filename,
        mimeType,
        sizeBytes: file.size,
        storageKey,
      }).returning();

      return c.json({
        attachment,
        url: await getSignedDownloadUrl(storageKey),
      }, 201);
    }

    // Return storage key for later association
    return c.json({
      storageKey,
      url: await getSignedDownloadUrl(storageKey),
      type: attachmentType,
      filename,
      mimeType,
      sizeBytes: file.size,
    }, 201);
  } catch (err) {
    logger.error({ err }, 'File upload failed');
    return c.json({ error: 'upload_failed', message: 'Failed to upload file' }, 500);
  }
});

// GET /api/files/:key — get signed URL for a file
uploadRouter.get('/files/*', async (c) => {
  const key = c.req.path.replace('/api/upload/files/', '');

  if (!key) {
    return c.json({ error: 'validation_error', message: 'File key is required' }, 400);
  }

  try {
    const url = await getSignedDownloadUrl(key);
    return c.redirect(url, 302);
  } catch (err) {
    logger.error({ err, key }, 'Failed to generate signed URL');
    return c.json({ error: 'not_found', message: 'File not found' }, 404);
  }
});

export default uploadRouter;
