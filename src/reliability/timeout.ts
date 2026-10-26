// src/reliability/timeout.ts
//
// Phase 6 Reliability: Timeout
//
// Why Timeout is Essential in an API Gateway:
// In distributed microservice architectures, upstream services occasionally hang due to
// deadlocks, garbage collection pauses, or database query starvation.
//
// Without a timeout:
// - The Gateway holds the client connection open indefinitely.
// - TCP sockets and file descriptors are depleted on the Gateway.
// - Thread pools / event loops become congested.
// - The Gateway crashes from a CASCADING FAILURE caused by one slow backend!
//
// With a timeout:
// - The Gateway cancels the upstream request after a fixed threshold (e.g. 3000ms).
// - Sockets and resources are reclaimed immediately.
// - The client receives an immediate HTTP 504 Gateway Timeout.

export class TimeoutError extends Error {
  public readonly timeoutMs: number;
  public readonly isTimeout = true;

  constructor(timeoutMs: number, message?: string) {
    super(message ?? `Upstream request timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wraps an async operation with a strict timeout using an AbortController.
 * Automatically cleans up timer resources when the operation finishes.
 *
 * @param operation Function receiving an AbortSignal to pass to fetch()
 * @param timeoutMs Maximum time to wait in milliseconds
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timerId: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      operation(controller.signal),
      timeoutPromise,
    ]);
    return result;
  } finally {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
  }
}
