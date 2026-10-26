// src/services/rateLimiterFactory.ts
//
// Rate Limiter Factory:
// Returns the correct rate limiter implementation based on the RATE_LIMIT_ALGORITHM env var.
//
// All three algorithms implement the same IRateLimiter interface, so the middleware
// doesn't need to know WHICH algorithm is running — it just calls consume().
//
// Supported algorithms:
//   'fixed-window'   → RedisRateLimiter       (INCR + EXPIRE)
//   'sliding-window' → SlidingWindowLimiter    (ZADD + ZREMRANGEBYSCORE + ZCARD)
//   'token-bucket'   → TokenBucketLimiter      (HMGET + HSET)

import Redis from 'ioredis';
import { RateLimitResult } from './rateLimitService';
import { RedisRateLimiter } from './redisRateLimiter';
import { SlidingWindowLimiter } from './slidingWindowLimiter';
import { TokenBucketLimiter } from './tokenBucketLimiter';

export type RateLimitAlgorithm = 'fixed-window' | 'sliding-window' | 'token-bucket';

// All limiters share this interface — swap algorithm without touching middleware
export interface IRateLimiter {
  consume(clientId: string): Promise<RateLimitResult>;
}

/**
 * Creates a rate limiter instance based on the chosen algorithm.
 *
 * @param algorithm     The algorithm name from env
 * @param redis         Shared ioredis client
 * @param windowMs      Rate limit window in milliseconds
 * @param maxRequests   Max allowed requests per window
 */
export function createRateLimiter(
  algorithm: string,
  redis: Redis,
  windowMs: number,
  maxRequests: number
): IRateLimiter {
  switch (algorithm) {

    case 'sliding-window':
      // Uses Redis Sorted Sets — tracks each request's exact timestamp
      return new SlidingWindowLimiter(redis, windowMs, maxRequests);

    case 'token-bucket': {
      // Tokens refill at a constant rate. Allows bursts up to `capacity`.
      // refillRate = how many tokens are added per second
      const refillRatePerSecond = maxRequests / (windowMs / 1000);
      return new TokenBucketLimiter(redis, maxRequests, refillRatePerSecond);
    }

    case 'fixed-window':
    default:
      // Default: INCR + EXPIRE — simplest and most common
      return new RedisRateLimiter(redis, windowMs, maxRequests);
  }
}
