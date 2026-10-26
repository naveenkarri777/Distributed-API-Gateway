// src/reliability/retry.ts
//
// Phase 6 Reliability: Retry + Exponential Backoff with Jitter
//
// Why Retry + Backoff is Essential in an API Gateway:
// Microservices experience transient hiccups: brief network packet drops, service restarts,
// or temporary GC pauses. If a gateway immediately fails on a transient glitch, the user
// experiences unnecessary errors.
//
// Why Exponential Backoff + Jitter?
// 1. Immediate retries would hammer an already struggling service ("Thundering Herd").
// 2. Exponential delay (100ms -> 200ms -> 400ms) gives the upstream time to recover.
// 3. Jitter (random 0-50ms) desynchronizes concurrent retrying requests so they don't hit at once.
//
// Idempotency Safety:
// We only retry safe/idempotent methods (GET, HEAD, PUT, DELETE, OPTIONS).
// Retrying a non-idempotent POST (e.g., /api/payments) could charge a customer twice!

import { RetryOptions } from './types';
import { TimeoutError } from './timeout';

export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 100,
  backoffMultiplier: 2,
  maxDelayMs: 2000,
  jitterMs: 50,
  retryableStatuses: [500, 502, 503, 504],
  retryableMethods: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'],
};

/**
 * Calculates exponential backoff delay with random full/decorrelated jitter.
 * Formula: min(maxDelayMs, initialDelayMs * multiplier^(attempt - 1)) + random(0, jitterMs)
 */
export function calculateBackoff(
  attempt: number,
  options: Required<RetryOptions>
): number {
  const exponentialDelay =
    options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);
  const jitter = Math.floor(Math.random() * (options.jitterMs + 1));
  return cappedDelay + jitter;
}

/**
 * Helper to pause execution for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determines whether a failed request should be retried based on:
 * 1. Number of attempts remaining
 * 2. HTTP method idempotency (e.g., safe for GET, unsafe for POST by default)
 * 3. Nature of the error (timeout, network drop, or 5xx server status)
 */
export function isRetryable(
  attempt: number,
  method: string,
  errorOrStatus: Error | number,
  options: Required<RetryOptions>
): boolean {
  if (attempt >= options.maxRetries) {
    return false;
  }

  // Idempotency check: Do not retry non-idempotent methods unless configured
  if (!options.retryableMethods.includes(method.toUpperCase())) {
    return false;
  }

  // HTTP status code check
  if (typeof errorOrStatus === 'number') {
    return options.retryableStatuses.includes(errorOrStatus);
  }

  // Error type check (Timeouts and Network connection failures)
  if (errorOrStatus instanceof TimeoutError || (errorOrStatus as any).isTimeout) {
    return true;
  }

  const msg = errorOrStatus.message.toLowerCase();
  const code = (errorOrStatus as any).code?.toUpperCase() ?? '';

  const networkErrorCodes = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
  ];

  if (networkErrorCodes.includes(code)) {
    return true;
  }

  if (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('connection refused')
  ) {
    return true;
  }

  return false;
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
}

/**
 * Executes an async operation with automatic retries and exponential backoff.
 */
export async function executeWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  method: string,
  isStatusFailure: (res: T) => number | null,
  customOptions?: RetryOptions,
  serviceName = 'upstream'
): Promise<RetryResult<T>> {
  const options: Required<RetryOptions> = {
    ...DEFAULT_RETRY_OPTIONS,
    ...customOptions,
  };

  let attempt = 1;

  while (true) {
    try {
      const result = await operation(attempt);

      // Check if the response returned an HTTP error status (e.g., 503)
      const failedStatus = isStatusFailure(result);
      if (failedStatus !== null && isRetryable(attempt, method, failedStatus, options)) {
        const delay = calculateBackoff(attempt, options);
        console.warn(
          `[Retry] [${serviceName}] Attempt ${attempt}/${options.maxRetries} returned HTTP ${failedStatus}. Retrying in ${delay}ms...`
        );
        await sleep(delay);
        attempt++;
        continue;
      }

      return { result, attempts: attempt };
    } catch (err: any) {
      if (isRetryable(attempt, method, err, options)) {
        const delay = calculateBackoff(attempt, options);
        console.warn(
          `[Retry] [${serviceName}] Attempt ${attempt}/${options.maxRetries} failed: ${err.message}. Retrying in ${delay}ms...`
        );
        await sleep(delay);
        attempt++;
        continue;
      }

      // Not retryable or exhausted attempts -> rethrow error
      throw err;
    }
  }
}
