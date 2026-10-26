// src/middleware/requestLogger.ts
//
// Phase 8 Observability: Structured Request Logger & Trace Propagation
//
// Logs every request in structured format:
//   requestId=abc123 method=GET path=/api/users gateway=Gateway-1 status=200 duration=42ms
//
// Automatically captures and attaches an X-Request-Id header so every request
// can be correlated across the Load Balancer, Gateways, and Microservices.

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { config } from '../config/env';
import { metricsRegistry } from '../observability/metrics';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  // 1. Trace Propagation: Use incoming X-Request-Id or generate a new UUID
  const incomingId = req.headers['x-request-id'];
  const requestId = Array.isArray(incomingId)
    ? incomingId[0]
    : incomingId || randomUUID();

  // Attach to request and response header
  (req as any).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Gateway', config.GATEWAY_INSTANCE_NAME);

  // 2. Structured log & Prometheus metrics on request completion
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const gateway = config.GATEWAY_INSTANCE_NAME;

    // Structured Log entry:
    console.log(
      `requestId=${requestId} method=${req.method} path=${req.originalUrl} gateway=${gateway} status=${res.statusCode} duration=${durationMs}ms`
    );

    // Record Prometheus metrics
    metricsRegistry.recordRequest(
      req.method,
      req.originalUrl,
      res.statusCode,
      durationMs,
      gateway
    );
  });

  next();
}
