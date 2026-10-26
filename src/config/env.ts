// src/config/env.ts
//
// Central Environment Configuration:
// Single source of truth for ports, upstream URLs, and rate limit settings.

export const config = {
  // Gateway listening port
  GATEWAY_PORT: parseInt(process.env.GATEWAY_PORT ?? '3000', 10),

  // Gateway instance identity (for multi-instance tracing and metrics)
  GATEWAY_INSTANCE_NAME: process.env.GATEWAY_INSTANCE_NAME ?? 'Gateway-1',

  // Upstream Microservice URLs
  USER_SERVICE_URL: process.env.USER_SERVICE_URL ?? 'http://localhost:4001',
  ORDER_SERVICE_URL: process.env.ORDER_SERVICE_URL ?? 'http://localhost:4002',
  PAYMENT_SERVICE_URL: process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:4003',

  // Rate Limiting Configuration
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? '5', 10),

  // Rate Limiting Algorithm (Phase 5)
  // Options: 'fixed-window' | 'sliding-window' | 'token-bucket'
  RATE_LIMIT_ALGORITHM: process.env.RATE_LIMIT_ALGORITHM ?? 'fixed-window',

  // Redis Store Configuration
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',

  // Reliability Configuration (Phase 6)
  // Upstream request timeout before returning 504 Gateway Timeout (default: 3000ms)
  PROXY_TIMEOUT_MS: parseInt(process.env.PROXY_TIMEOUT_MS ?? '3000', 10),

  // Maximum retry attempts for transient upstream failures (default: 3)
  RETRY_MAX_ATTEMPTS: parseInt(process.env.RETRY_MAX_ATTEMPTS ?? '3', 10),

  // Initial exponential backoff delay in ms (default: 100ms)
  RETRY_INITIAL_DELAY_MS: parseInt(process.env.RETRY_INITIAL_DELAY_MS ?? '100', 10),

  // Number of consecutive failures to trip Circuit Breaker to OPEN (default: 5)
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: parseInt(
    process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? '5',
    10
  ),

  // Circuit Breaker cooldown in ms before switching from OPEN to HALF-OPEN (default: 10000ms)
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: parseInt(
    process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS ?? '10000',
    10
  ),
} as const;
