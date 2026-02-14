import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgres://termchat:termchat_dev@localhost:5432/termchat'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().default('dev-secret-change-in-prod'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('30d'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_ACCESS_KEY: z.string().default('termchat'),
  S3_SECRET_KEY: z.string().default('termchat_dev'),
  S3_BUCKET: z.string().default('termchat-uploads'),
  OPENCLAW_GATEWAY: z.string().default('ws://127.0.0.1:18789'),
  CORS_ORIGINS: z.string().default(''),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  jwt: {
    secret: env.JWT_SECRET,
    accessExpiry: env.JWT_ACCESS_EXPIRY,
    refreshExpiry: env.JWT_REFRESH_EXPIRY,
  },
  s3: {
    endpoint: env.S3_ENDPOINT,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
  },
  openclawGateway: env.OPENCLAW_GATEWAY,
  corsOrigins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map(s => s.trim()) : [],
  port: env.PORT,
  host: env.HOST,
  nodeEnv: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
} as const;
