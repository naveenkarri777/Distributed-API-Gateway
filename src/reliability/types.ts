// src/reliability/types.ts
//
// Phase 6: Reliability Type Definitions
// Defines interfaces for Timeout, Retry + Backoff, and Circuit Breaker.

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF-OPEN';

export interface CircuitBreakerOptions {
  /** Name of the upstream service (e.g., 'user-service') */
  name: string;
  /** Number of consecutive failures to trip circuit to OPEN (default: 5) */
  failureThreshold?: number;
  /** Cooldown time in ms before switching from OPEN to HALF-OPEN (default: 10000) */
  resetTimeoutMs?: number;
  /** Number of successful probe calls in HALF-OPEN before switching to CLOSED (default: 1) */
  halfOpenSuccessThreshold?: number;
}

export interface CircuitBreakerStats {
  name: string;
  state: CircuitBreakerState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalRequests: number;
  totalFailures: number;
  lastFailureTime: string | null;
  lastSuccessTime: string | null;
  lastStateChange: string;
  nextProbeTime: string | null;
}

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay before first retry in milliseconds (default: 100) */
  initialDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Maximum delay cap in milliseconds (default: 2000) */
  maxDelayMs?: number;
  /** Maximum jitter in milliseconds added to avoid thundering herd (default: 50) */
  jitterMs?: number;
  /** HTTP status codes that should trigger a retry (default: [500, 502, 503, 504]) */
  retryableStatuses?: number[];
  /** HTTP methods considered safe/idempotent to retry (default: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) */
  retryableMethods?: string[];
}

export interface TimeoutOptions {
  /** Timeout in milliseconds before aborting upstream request (default: 3000) */
  timeoutMs: number;
  /** Custom error message */
  message?: string;
}

export interface ReliableProxyOptions {
  serviceName: string;
  targetUrl: string;
  pathRewrite?: Record<string, string>;
  timeoutMs?: number;
  retry?: RetryOptions;
  circuitBreaker?: CircuitBreakerOptions;
}
