import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redisUrl);
export const redisSub = new Redis(config.redisUrl);
export const redisPub = new Redis(config.redisUrl);
