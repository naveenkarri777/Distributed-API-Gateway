// src/config/redis.ts
//
// Shared Redis Client Configuration:
// Connects to Redis via ioredis with automatic reconnection and backoff.

import Redis from 'ioredis';
import { config } from './env';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 100, 2000);
  },
  lazyConnect: true,
});

redis.on('connect', () => {
  console.log(`[Redis] Connected to ${config.REDIS_URL}`);
});

redis.on('error', (err) => {
  console.warn(`[Redis Connection Warning] ${err.message}`);
});
