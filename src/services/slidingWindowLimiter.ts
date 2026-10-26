// src/services/slidingWindowLimiter.ts
//
// Sliding Window Rate Limiter (Redis Sorted Set):
//
// Unlike Fixed Window, this algorithm tracks EACH individual request's timestamp.
// It counts only requests that fall within the last `windowMs` milliseconds
// relative to "right now" — not relative to a fixed clock boundary.
//
// HOW IT WORKS:
//   Redis Sorted Set: key = "ratelimit:sliding:user:Alice"
//                     score = request timestamp (ms)
//                     member = unique ID per request
//
//   On every request:
//     1. ZREMRANGEBYSCORE  — remove all entries older than (now - windowMs)
//     2. ZADD              — add current request with timestamp as score
//     3. ZCARD             — count how many entries remain (= requests in window)
//     4. EXPIRE            — keep the key alive for one window duration
//
// WHY THIS IS BETTER THAN FIXED WINDOW:
//   Fixed Window resets its counter at a fixed clock tick (e.g. every minute on the minute).
//   This creates a "burst problem":
//     - User sends 5 requests at 00:59  → all allowed (first window)
//     - User sends 5 requests at 01:01  → all allowed (second window)
//     - In 2 seconds the user sent 10 requests — twice the limit!
//
//   Sliding Window always looks back exactly `windowMs` from NOW.
//   There is no reset boundary to exploit.

import Redis from 'ioredis';
import { RateLimitResult } from './rateLimitService';

export class SlidingWindowLimiter {
  private redis: Redis;
  private windowMs: number;
  private maxRequests: number;

  constructor(redisClient: Redis, windowMs: number, maxRequests: number) {
    this.redis = redisClient;
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  public async consume(clientId: string): Promise<RateLimitResult> {
    const key = `ratelimit:sliding:${clientId}`;
    const now = Date.now();
    const windowStart = now - this.windowMs;                          // oldest allowed timestamp
    const windowSeconds = Math.max(1, Math.ceil(this.windowMs / 1000));

    try {
      // Pipeline: send all 4 commands in one TCP round-trip for efficiency.
      // Redis executes them in order — no interleaving from other clients.
      const pipeline = this.redis.pipeline();

      // 1. Remove all requests that are now outside the sliding window
      pipeline.zremrangebyscore(key, 0, windowStart);

      // 2. Record this request: member = unique ID, score = current timestamp
      //    Using `${now}-${Math.random()}` ensures uniqueness even for
      //    requests arriving in the same millisecond.
      pipeline.zadd(key, now, `${now}-${Math.random().toString(36).slice(2)}`);

      // 3. Count how many requests exist within the window (after removal)
      pipeline.zcard(key);

      // 4. Reset TTL so the key doesn't linger indefinitely after inactivity
      pipeline.expire(key, windowSeconds);

      const results = await pipeline.exec();

      // results[2] = ZCARD result → [error, count]
      const currentCount = (results![2][1] as number) ?? 0;

      const allowed = currentCount <= this.maxRequests;
      const remaining = Math.max(0, this.maxRequests - currentCount);

      // Reset time: the oldest entry in the set + windowMs = when space frees up.
      // Approximation: now + windowMs (worst case — if all slots are full).
      const retryAfterSeconds = allowed ? 0 : windowSeconds;

      return {
        allowed,
        limit: this.maxRequests,
        remaining,
        resetTime: now + this.windowMs,
        retryAfterSeconds,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[SlidingWindow Fallback] ${message}. Fail-open.`);
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: 1,
        resetTime: Date.now() + this.windowMs,
        retryAfterSeconds: windowSeconds,
      };
    }
  }

  public async reset(clientId: string): Promise<void> {
    await this.redis.del(`ratelimit:sliding:${clientId}`);
  }
}
