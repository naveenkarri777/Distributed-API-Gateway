// src/services/redisRateLimiter.ts
//
// Distributed Redis Rate Limiter Service:
// Enforces a fixed-window rate limit using atomic Redis commands (INCR, EXPIRE, TTL).
// Ensures all gateway instances share one centralized counter.

import Redis from 'ioredis';
import { RateLimitResult } from './rateLimitService';

export class RedisRateLimiter {
  private redis: Redis;
  private windowMs: number;
  private maxRequests: number;

  constructor(redisClient: Redis, windowMs: number, maxRequests: number) {
    this.redis = redisClient;
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /**
   * Atomically consumes 1 request token for the given clientId.
   */
  public async consume(clientId: string): Promise<RateLimitResult> {
    const key = `ratelimit:${clientId}`;
    const windowSeconds = Math.max(1, Math.ceil(this.windowMs / 1000));

    try {
      // 1. INCR: Atomically increment key counter
      const currentCount = await this.redis.incr(key);

      // 2. EXPIRE: Set window TTL on the first request
      if (currentCount === 1) {
        await this.redis.expire(key, windowSeconds);
      }

      // 3. TTL: Fetch remaining seconds before expiry
      let ttl = await this.redis.ttl(key);
      if (ttl <= 0) {
        ttl = windowSeconds;
        await this.redis.expire(key, windowSeconds);
      }

      const allowed = currentCount <= this.maxRequests;
      const remaining = Math.max(0, this.maxRequests - currentCount);
      const resetTime = Date.now() + ttl * 1000;

      return {
        allowed,
        limit: this.maxRequests,
        remaining,
        resetTime,
        retryAfterSeconds: ttl,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Redis RateLimiter Fallback] Redis error: ${message}. Permitting request (Fail-Open).`);

      // Fail-open fallback: if Redis fails, do not block users
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: 1,
        resetTime: Date.now() + this.windowMs,
        retryAfterSeconds: windowSeconds,
      };
    }
  }

  /**
   * Resets rate limit counter for a specific client.
   */
  public async reset(clientId: string): Promise<void> {
    await this.redis.del(`ratelimit:${clientId}`);
  }
}
