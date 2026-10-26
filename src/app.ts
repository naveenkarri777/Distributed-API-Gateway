// src/app.ts
//
// Express Application Assembly:
// Configures global middleware and routing in sequential order:
//   1. Request Logger  (logs method and tracks latency)
//   2. Rate Limiter    (distributed Redis rate limiting guard)
//   3. Gateway Routes  (maps /api/* to upstream microservices)

import express from 'express';
import { requestLogger } from './middleware/requestLogger';
import { rateLimiter } from './middleware/rateLimiter';
import { metricsRegistry } from './observability/metrics';
import gatewayRoutes from './gateway/routes';

const app = express();

// 1. Prometheus Metrics exposition endpoint (scraped by Prometheus on :9090)
app.get('/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metricsRegistry.getPrometheusMetrics());
});

// 2. Log request arrival, propagate X-Request-Id, and measure response latency
app.use(requestLogger);

// 3. Guard microservices against excessive traffic (Distributed Redis)
app.use(rateLimiter);

// Note: In an API Gateway / reverse proxy, express.json() is NOT used globally.
// The gateway streams raw request bytes (POST/PUT bodies) directly to microservices.

// 4. Mount upstream service routes
app.use('/', gatewayRoutes);

// 4. Catch-all fallback for unmatched paths
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found', message: 'No route matched on the gateway' });
});

export default app;
