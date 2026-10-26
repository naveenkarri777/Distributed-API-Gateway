// src/reliability/circuitBreaker.ts
//
// Phase 6 Reliability: Circuit Breaker Pattern
//
// Why Circuit Breakers are Essential in an API Gateway:
// When an upstream microservice crashes or experiences an outage, continuing to send
// hundreds of requests per second causes:
// 1. Thread and socket starvation on the gateway.
// 2. Cascading failure across the entire application ecosystem.
// 3. Complete prevention of the downstream service ever recovering (it is hit by traffic while trying to boot).
//
// The Circuit Breaker acts as an electrical circuit breaker:
//
//     ┌────────────────────────────────────────────────────────┐
//     │                                                        │
//     ▼                                                        │
// ┌────────┐  5 Consecutive Failures   ┌────────┐  Cooldown    │ Probe
// │ CLOSED │ ────────────────────────> │  OPEN  │ ──────────┐  │ Succeeded
// └────────┘                           └────────┘           │  │
//     ▲                                                     ▼  │
//     │                                                ┌───────────┐
//     └────────────────────────────────────────────────┤ HALF-OPEN │
//                        Probe Failed                  └───────────┘
//                      (trip back to OPEN) ───────────────▲
//
// 1. CLOSED:
//    Normal state. All requests pass to upstream. Failures are counted.
// 2. OPEN:
//    Upstream is down. All requests fail instantly (<1ms) with HTTP 503 without touching upstream.
// 3. HALF-OPEN:
//    Cooldown expired. Allows a trial probe request. If it succeeds, circuit heals to CLOSED.
//    If probe fails, trips back to OPEN.

import {
  CircuitBreakerState,
  CircuitBreakerOptions,
  CircuitBreakerStats,
} from './types';

export class CircuitBreakerOpenError extends Error {
  public readonly serviceName: string;
  public readonly nextProbeTime: string | null;

  constructor(serviceName: string, nextProbeTime: string | null) {
    super(`Circuit breaker is OPEN for service '${serviceName}'. Fast-failing request.`);
    this.name = 'CircuitBreakerOpenError';
    this.serviceName = serviceName;
    this.nextProbeTime = nextProbeTime;
  }
}

export class CircuitBreaker {
  public readonly name: string;
  private state: CircuitBreakerState = 'CLOSED';

  private failureThreshold: number;
  private resetTimeoutMs: number;
  private halfOpenSuccessThreshold: number;

  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private totalRequests = 0;
  private totalFailures = 0;

  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private lastStateChange: number = Date.now();
  private nextProbeTime: number | null = null;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 10000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 1;
  }

  /**
   * Returns current state, auto-evaluating whether OPEN has cooled down to HALF-OPEN.
   */
  public getState(): CircuitBreakerState {
    if (this.state === 'OPEN' && this.nextProbeTime !== null && Date.now() >= this.nextProbeTime) {
      this.transitionTo('HALF-OPEN', 'Cooldown elapsed. Probing upstream health.');
    }
    return this.state;
  }

  /**
   * Checks whether a request is permitted to execute.
   * If OPEN and still cooling down, throws CircuitBreakerOpenError (fast-fail).
   */
  public checkCanExecute(): void {
    const currentState = this.getState();

    if (currentState === 'OPEN') {
      const probeIso = this.nextProbeTime ? new Date(this.nextProbeTime).toISOString() : null;
      throw new CircuitBreakerOpenError(this.name, probeIso);
    }
  }

  /**
   * Records a successful upstream invocation.
   */
  public recordSuccess(): void {
    this.totalRequests++;
    this.lastSuccessTime = Date.now();

    const currentState = this.getState();

    if (currentState === 'HALF-OPEN') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.transitionTo('CLOSED', `Probe succeeded (${this.consecutiveSuccesses} ok). Upstream recovered.`);
        this.consecutiveFailures = 0;
      }
    } else if (currentState === 'CLOSED') {
      // Normal operation: keep failure counter clean
      this.consecutiveFailures = 0;
    }
  }

  /**
   * Records an upstream invocation failure (e.g., timeout, network crash, 5xx).
   */
  public recordFailure(err?: Error | string): void {
    this.totalRequests++;
    this.totalFailures++;
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    const currentState = this.getState();
    const reason = typeof err === 'string' ? err : err?.message ?? 'Unknown failure';

    if (currentState === 'CLOSED') {
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.nextProbeTime = Date.now() + this.resetTimeoutMs;
        this.transitionTo(
          'OPEN',
          `Threshold reached (${this.consecutiveFailures}/${this.failureThreshold} consecutive failures). Last: ${reason}`
        );
      }
    } else if (currentState === 'HALF-OPEN') {
      // Probe failed: trip immediately back to OPEN
      this.nextProbeTime = Date.now() + this.resetTimeoutMs;
      this.transitionTo('OPEN', `Probe request failed (${reason}). Upstream still down.`);
    }
  }

  private transitionTo(newState: CircuitBreakerState, reason: string): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();
    this.consecutiveSuccesses = 0;

    console.warn(
      `[CircuitBreaker: ${this.name}] State transition: ${oldState} -> ${newState}. Reason: ${reason}`
    );
  }

  /**
   * Returns complete statistics for observability and monitoring dashboards.
   */
  public getStats(): CircuitBreakerStats {
    return {
      name: this.name,
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
      lastSuccessTime: this.lastSuccessTime ? new Date(this.lastSuccessTime).toISOString() : null,
      lastStateChange: new Date(this.lastStateChange).toISOString(),
      nextProbeTime: this.nextProbeTime ? new Date(this.nextProbeTime).toISOString() : null,
    };
  }

  /**
   * Manually resets circuit breaker to CLOSED.
   */
  public reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.nextProbeTime = null;
    this.lastStateChange = Date.now();
    console.log(`[CircuitBreaker: ${this.name}] Manually reset to CLOSED.`);
  }

  /**
   * For testing: manually trip to OPEN.
   */
  public trip(): void {
    this.nextProbeTime = Date.now() + this.resetTimeoutMs;
    this.transitionTo('OPEN', 'Manually tripped for testing.');
  }
}

/**
 * Registry holding one CircuitBreaker per upstream service (Bulkhead isolation).
 */
class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  public getOrCreate(name: string, options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({
        name,
        failureThreshold: options?.failureThreshold,
        resetTimeoutMs: options?.resetTimeoutMs,
        halfOpenSuccessThreshold: options?.halfOpenSuccessThreshold,
      });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  public get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  public getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers.entries()) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  public resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();
