// src/middleware/rateLimiter.ts
//
// Distributed Rate Limiter Middleware:
// Intercepts requests before reaching downstream routes.
// Delegates to whichever algorithm is selected via RATE_LIMIT_ALGORITHM env var.

import { Request, Response, NextFunction } from 'express';
import { createRateLimiter } from '../services/rateLimiterFactory';
import { redis } from '../config/redis';
import { config } from '../config/env';
import { metricsRegistry } from '../observability/metrics';

// Factory picks the algorithm: 'fixed-window' | 'sliding-window' | 'token-bucket'
export const rateLimiterService = createRateLimiter(
  config.RATE_LIMIT_ALGORITHM,
  redis,
  config.RATE_LIMIT_WINDOW_MS,
  config.RATE_LIMIT_MAX_REQUESTS
);

/**
 * Extracts a unique client identifier from request headers or IP address.
 * Priority:
 *   1. 'x-user-id' header (e.g. user:Alice)
 *   2. 'x-api-key' header (e.g. key:xyz)
 *   3. Client IP address (fallback)
 */
function getClientId(req: Request): string {
  const userId = req.headers['x-user-id'] as string | undefined;
  if (userId && userId.trim().length > 0) {
    return `user:${userId.trim()}`;
  }

  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey && apiKey.trim().length > 0) {
    return `key:${apiKey.trim()}`;
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return `ip:${ip}`;
}

/**
 * Rate Limiter middleware function for Express.
 */
export async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Exclude health checks and Prometheus metrics from rate limiting
  if (req.path === '/health' || req.path === '/metrics' || req.path.startsWith('/health/')) {
    return next();
  }

  const clientId = getClientId(req);

  try {
    const result = await rateLimiterService.consume(clientId);

    // Standard IETF rate limit headers
    res.setHeader('X-RateLimit-Limit', result.limit.toString());
    res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000).toString());

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfterSeconds.toString());

      // Record rate limit metric for Prometheus
      metricsRegistry.recordRateLimitRejection(clientId, config.RATE_LIMIT_ALGORITHM);

      console.warn(`[RateLimit 429] Client '${clientId}' exceeded limit of ${result.limit} requests.`);

      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit of ${result.limit} requests per ${config.RATE_LIMIT_WINDOW_MS / 1000}s exceeded. Try again in ${result.retryAfterSeconds} seconds.`,
        clientId,
        limit: result.limit,
        remaining: 0,
        retryAfterSeconds: result.retryAfterSeconds,
      });
      return;
    }

    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[RateLimiter Error]', message);
    // Fail-open: allow request through rather than crashing the gateway
    next();
  }
}
