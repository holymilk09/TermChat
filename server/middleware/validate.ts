import { Context, Next } from 'hono';
import { z, ZodSchema } from 'zod';

export function validate<T extends ZodSchema>(schema: T) {
  return async (c: Context, next: Next) => {
    try {
      const body = await c.req.json();
      const result = schema.safeParse(body);
      if (!result.success) {
        return c.json(
          {
            error: 'validation_error',
            message: 'Invalid request body',
            details: result.error.flatten().fieldErrors,
          },
          400
        );
      }
      c.set('validatedBody' as never, result.data as never);
      await next();
    } catch {
      return c.json(
        { error: 'validation_error', message: 'Invalid JSON body' },
        400
      );
    }
  };
}

// Common validation schemas
export const registerSchema = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_]+$/, 'Username must be alphanumeric with underscores'),
  password: z.string().min(8).max(128),
  email: z.string().email().optional(),
  displayName: z.string().max(128).optional(),
});

export const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export const createConversationSchema = z.object({
  type: z.enum(['dm', 'group', 'channel']),
  name: z.string().max(256).optional(),
  description: z.string().optional(),
  memberIds: z.array(z.string().uuid()).min(1),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000).optional(),
  type: z.enum(['text', 'system', 'code']).default('text'),
  replyToId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
  attachmentIds: z.array(z.string().uuid()).optional(),
}).refine(
  (data) => data.content || (data.attachmentIds && data.attachmentIds.length > 0),
  { message: 'Message must have content or at least one attachment' }
);

export const editMessageSchema = z.object({
  content: z.string().min(1).max(10000),
});

export const updateUserSchema = z.object({
  displayName: z.string().max(128).optional(),
  avatarUrl: z.string().url().optional(),
  settings: z.record(z.unknown()).optional(),
});

export const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['admin', 'member', 'bot']).default('member'),
});
