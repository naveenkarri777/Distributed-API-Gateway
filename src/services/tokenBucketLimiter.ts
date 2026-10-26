// src/services/tokenBucketLimiter.ts
//
// Token Bucket Rate Limiter (Redis Hash):
//
// Imagine a bucket that holds tokens. Tokens refill at a constant rate over time.
// Each incoming request consumes 1 token. If the bucket is empty → reject (429).
//
// KEY PROPERTIES:
//   - Allows controlled BURSTS: if a client hasn't sent requests in a while,
//     they accumulate tokens and can burst several requests at once.
//   - Smooth average rate: no matter how tokens are spent, refill rate caps
//     the sustained throughput.
//
// PARAMETERS:
//   capacity         = max tokens in bucket   (= RATE_LIMIT_MAX_REQUESTS)
//   refillRatePerSec = tokens added per second (= maxRequests / windowSeconds)
//
// EXAMPLE (capacity=5, refillRate=5/60 ≈ 0.083 tokens/sec):
//   t=0s:  bucket=5 (full) → request 1→4 tokens left
//   t=0s:  request 2 → 3 tokens left
//   t=0s:  request 3 → 2 tokens left
//   t=0s:  request 4 → 1 token left
//   t=0s:  request 5 → 0 tokens left
//   t=0s:  request 6 → BLOCKED (bucket empty)
//   t=12s: 1 token refilled → request 7 → allowed
//
// STORAGE IN REDIS (Hash key: ratelimit:token:user:Alice):
//   Field "tokens"     → current float token count (e.g. "4.16")
//   Field "lastRefill" → unix timestamp in seconds when we last computed tokens
//
// NOTE ON ATOMICITY:
//   In production, this would be wrapped in a Redis Lua script (EVAL) to make
//   the read-compute-write cycle fully atomic. For this project (learning phase),
//   we do it in two round-trips (HMGET then HSET). A concurrent request could
//   theoretically interfere, but this is rare and illustrates the concept clearly.

import Redis from 'ioredis';
import { RateLimitResult } from './rateLimitService';

export class TokenBucketLimiter {
  private redis: Redis;
  private capacity: number;        // max tokens (burst ceiling)
  private refillRate: number;      // tokens added per second

  constructor(redisClient: Redis, capacity: number, refillRatePerSecond: number) {
    this.redis = redisClient;
    this.capacity = capacity;
    this.refillRate = refillRatePerSecond;
  }

  public async consume(clientId: string): Promise<RateLimitResult> {
    const key = `ratelimit:token:${clientId}`;
    const nowSeconds = Date.now() / 1000;   // use float seconds for precision

    try {
      // --- Step 1: Read current bucket state ---
      // HMGET returns [tokensStr, lastRefillStr] — null if field doesn't exist yet
      const [tokensStr, lastRefillStr] = await this.redis.hmget(key, 'tokens', 'lastRefill');

      // First-time client: start with a full bucket
      let tokens = tokensStr !== null ? parseFloat(tokensStr) : this.capacity;
      let lastRefill = lastRefillStr !== null ? parseFloat(lastRefillStr) : nowSeconds;

      // --- Step 2: Refill tokens based on elapsed time ---
      // elapsed = seconds since we last computed the bucket
      // tokensToAdd = how many tokens have refilled during that time
      const elapsed = Math.max(0, nowSeconds - lastRefill);
      const tokensToAdd = elapsed * this.refillRate;

      // Cap at capacity — bucket can't overflow
      tokens = Math.min(this.capacity, tokens + tokensToAdd);
      lastRefill = nowSeconds;

      // --- Step 3: Try to consume 1 token ---
      const allowed = tokens >= 1;
      if (allowed) {
        tokens -= 1;   // consume the token
      }

      // --- Step 4: Write updated state back to Redis ---
      // TTL = time for empty bucket to fully refill + buffer
      const ttlSeconds = Math.ceil(this.capacity / this.refillRate) + 10;
      await this.redis.hset(key, 'tokens', tokens.toFixed(6), 'lastRefill', lastRefill.toFixed(6));
      await this.redis.expire(key, ttlSeconds);

      const remaining = Math.floor(tokens);

      // How long until 1 token refills if currently blocked?
      const retryAfterSeconds = allowed
        ? 0
        : Math.ceil((1 - tokens) / this.refillRate);

      return {
        allowed,
        limit: this.capacity,
        remaining,
        resetTime: Date.now() + retryAfterSeconds * 1000,
        retryAfterSeconds,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[TokenBucket Fallback] ${message}. Fail-open.`);
      return {
        allowed: true,
        limit: this.capacity,
        remaining: 1,
        resetTime: Date.now() + 1000,
        retryAfterSeconds: 0,
      };
    }
  }

  public async reset(clientId: string): Promise<void> {
    await this.redis.del(`ratelimit:token:${clientId}`);
  }
}
