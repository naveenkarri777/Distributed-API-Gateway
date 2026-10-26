// src/services/rateLimitService.ts
//
// In-Memory Rate Limiter Service:
// Used as a standalone algorithm baseline (Phase 3).
// Tracks per-client request counts inside a local Map with automatic garbage collection.

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTime: number; // Unix timestamp in ms
  retryAfterSeconds: number;
}

interface ClientRecord {
  count: number;
  resetTime: number;
}

export class InMemoryRateLimiter {
  private store: Map<string, ClientRecord> = new Map();
  private windowMs: number;
  private maxRequests: number;
  private cleanupInterval: NodeJS.Timeout;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;

    // Periodic cleanup every 60 seconds to prevent memory leaks from inactive clients
    this.cleanupInterval = setInterval(() => this.cleanupExpiredRecords(), 60000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Consume 1 request token for the given clientId.
   */
  public consume(clientId: string): RateLimitResult {
    const now = Date.now();
    let record = this.store.get(clientId);

    // If record does not exist or window has expired, reset window
    if (!record || now >= record.resetTime) {
      record = {
        count: 1,
        resetTime: now + this.windowMs,
      };
      this.store.set(clientId, record);

      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: this.maxRequests - 1,
        resetTime: record.resetTime,
        retryAfterSeconds: Math.ceil((record.resetTime - now) / 1000),
      };
    }

    record.count += 1;
    this.store.set(clientId, record);

    const allowed = record.count <= this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - record.count);
    const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000);

    return {
      allowed,
      limit: this.maxRequests,
      remaining,
      resetTime: record.resetTime,
      retryAfterSeconds,
    };
  }

  /**
   * Resets rate limit for a specific client.
   */
  public reset(clientId: string): void {
    this.store.delete(clientId);
  }

  /**
   * Remove expired client records to free memory.
   */
  private cleanupExpiredRecords(): void {
    const now = Date.now();
    for (const [clientId, record] of this.store.entries()) {
      if (now >= record.resetTime) {
        this.store.delete(clientId);
      }
    }
  }
}
