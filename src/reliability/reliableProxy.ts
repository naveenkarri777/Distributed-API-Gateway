// src/reliability/reliableProxy.ts
//
// Phase 6 Reliability: Reliable Forwarding Proxy
//
// Unifies the Three Pillars of Reliability:
// 1. Circuit Breaker  -> Fast-fails instantly if upstream is dead.
// 2. Retry + Backoff  -> Automatically retries transient 5xx / network drops with exponential backoff.
// 3. Timeout          -> Aborts upstream calls that hang, returning 504 Gateway Timeout.

import { Request, Response, NextFunction } from 'express';
import { TimeoutError, withTimeout } from './timeout';
import { executeWithRetry } from './retry';
import {
  CircuitBreakerOpenError,
  circuitBreakerRegistry,
} from './circuitBreaker';
import { ReliableProxyOptions } from './types';
import { config } from '../config/env';
import { metricsRegistry } from '../observability/metrics';

// Hop-by-hop HTTP headers that must not be forwarded between proxies
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/**
 * Reads the incoming Express request stream into a Buffer.
 * Preserves raw bytes so the body can be re-transmitted across retry attempts.
 */
async function readRequestBody(req: Request): Promise<Buffer | undefined> {
  if (['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    return undefined;
  }

  // If already parsed by a body parser
  if ((req as any).rawBody) {
    return (req as any).rawBody;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

/**
 * Creates an Express middleware for reliable upstream proxying.
 */
export function createReliableProxy(options: ReliableProxyOptions) {
  const {
    serviceName,
    targetUrl,
    pathRewrite,
    timeoutMs = config.PROXY_TIMEOUT_MS,
    retry = {
      maxRetries: config.RETRY_MAX_ATTEMPTS,
      initialDelayMs: config.RETRY_INITIAL_DELAY_MS,
    },
    circuitBreaker: cbOptions,
  } = options;

  const circuitBreaker = circuitBreakerRegistry.getOrCreate(serviceName, {
    failureThreshold: cbOptions?.failureThreshold ?? config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    resetTimeoutMs: cbOptions?.resetTimeoutMs ?? config.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    halfOpenSuccessThreshold: cbOptions?.halfOpenSuccessThreshold ?? 1,
  });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startTime = Date.now();

    // 1. Circuit Breaker Check: Fast-fail if circuit is OPEN
    try {
      circuitBreaker.checkCanExecute();
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        metricsRegistry.recordFailedRequest(serviceName, 'circuit_breaker_open');
        metricsRegistry.updateCircuitBreakerState(serviceName, 'OPEN');

        res.setHeader('X-Circuit-Breaker-State', 'OPEN');
        res.setHeader('Retry-After', '10');
        res.status(503).json({
          error: 'Service Unavailable',
          message: err.message,
          service: serviceName,
          circuitBreaker: {
            state: 'OPEN',
            nextProbeTime: err.nextProbeTime,
          },
        });
        return;
      }
      return next(err);
    }

    // 2. Compute upstream URL path rewrite
    let targetPath = req.originalUrl;
    if (pathRewrite) {
      for (const [pattern, replacement] of Object.entries(pathRewrite)) {
        const regex = new RegExp(pattern);
        if (regex.test(targetPath)) {
          targetPath = targetPath.replace(regex, replacement);
          break;
        }
      }
    }

    const fullUpstreamUrl = new URL(targetPath, targetUrl).toString();

    // 3. Buffer request body for retry support
    let bodyBuffer: Buffer | undefined;
    try {
      bodyBuffer = await readRequestBody(req);
    } catch (readErr: any) {
      res.status(400).json({ error: 'Bad Request', message: `Failed to read request body: ${readErr.message}` });
      return;
    }

    // 4. Prepare forward headers (propagate tracing headers)
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && value !== undefined) {
        forwardHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }
    const reqId = (req as any).requestId || req.headers['x-request-id'];
    if (reqId) {
      forwardHeaders['x-request-id'] = String(reqId);
    }
    forwardHeaders['x-forwarded-for'] = req.ip || req.socket.remoteAddress || '127.0.0.1';
    forwardHeaders['x-forwarded-proto'] = req.protocol;

    // 5. Execute with Retry + Exponential Backoff + Timeout per attempt
    try {
      const retryResult = await executeWithRetry<globalThis.Response>(
        async (_attemptNumber) => {
          return await withTimeout(
            (signal) =>
              fetch(fullUpstreamUrl, {
                method: req.method,
                headers: forwardHeaders,
                body: bodyBuffer,
                signal,
                // duplex needed in Node 18+ for streaming requests with bodies
                ...(bodyBuffer ? { duplex: 'half' as any } : {}),
              }),
            timeoutMs
          );
        },
        req.method,
        // Status code evaluation: returns status if it is a retryable 5xx server error
        (upstreamResponse) => {
          if (upstreamResponse.status >= 500 && upstreamResponse.status <= 504) {
            return upstreamResponse.status;
          }
          return null;
        },
        retry,
        serviceName
      );

      const upstreamRes = retryResult.result;
      const attempts = retryResult.attempts;

      // Check if the final response was an upstream 5xx error
      if (upstreamRes.status >= 500) {
        circuitBreaker.recordFailure(`Upstream returned HTTP ${upstreamRes.status}`);
        metricsRegistry.recordUpstreamError(serviceName, upstreamRes.status);
        metricsRegistry.recordFailedRequest(serviceName, `upstream_${upstreamRes.status}`);
      } else {
        circuitBreaker.recordSuccess();
      }

      // Update circuit breaker metric state
      metricsRegistry.updateCircuitBreakerState(serviceName, circuitBreaker.getState());

      // 6. Forward upstream headers to client
      res.status(upstreamRes.status);
      for (const [key, value] of upstreamRes.headers.entries()) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      // Diagnostic Reliability headers
      const latencyMs = Date.now() - startTime;
      res.setHeader('X-Circuit-Breaker-State', circuitBreaker.getState());
      res.setHeader('X-Retry-Attempts', String(attempts));
      res.setHeader('X-Upstream-Latency-Ms', String(latencyMs));

      // Forward response body
      const buffer = Buffer.from(await upstreamRes.arrayBuffer());
      res.send(buffer);
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      circuitBreaker.recordFailure(err);
      metricsRegistry.updateCircuitBreakerState(serviceName, circuitBreaker.getState());

      res.setHeader('X-Circuit-Breaker-State', circuitBreaker.getState());
      res.setHeader('X-Upstream-Latency-Ms', String(latencyMs));

      // Timeout handler -> 504 Gateway Timeout
      if (err instanceof TimeoutError || err.name === 'TimeoutError' || err.isTimeout) {
        metricsRegistry.recordUpstreamTimeout(serviceName);
        metricsRegistry.recordFailedRequest(serviceName, 'timeout');

        console.error(`[ReliableProxy] [${serviceName}] Timeout after ${timeoutMs}ms on ${req.method} ${fullUpstreamUrl}`);
        res.status(504).json({
          error: 'Gateway Timeout',
          message: `Upstream service '${serviceName}' did not respond within ${timeoutMs}ms.`,
          service: serviceName,
          timeoutMs,
        });
        return;
      }

      // Network / Connection handler -> 502 Bad Gateway
      metricsRegistry.recordFailedRequest(serviceName, 'network_failure');
      console.error(`[ReliableProxy] [${serviceName}] Upstream unreachable: ${err.message}`);
      res.status(502).json({
        error: 'Bad Gateway',
        message: `Could not reach upstream service '${serviceName}': ${err.message}`,
        service: serviceName,
      });
    }
  };
}
