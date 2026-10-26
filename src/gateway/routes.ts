// src/gateway/routes.ts
//
// Gateway Route Table with Phase 6 Reliability:
// Maps incoming client path prefixes to internal upstream microservices
// protected by Timeout, Retry + Backoff, and Circuit Breaker:
//   - /api/users/*    -> User Service    (:4001) [user-service CB]
//   - /api/orders/*   -> Order Service   (:4002) [order-service CB]
//   - /api/payments/* -> Payment Service (:4003) [payment-service CB]

import { Router, Request, Response } from 'express';
import { createReliableProxy } from '../reliability/reliableProxy';
import { circuitBreakerRegistry } from '../reliability/circuitBreaker';
import { config } from '../config/env';

const router = Router();

// Gateway health check (includes live circuit breaker states)
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    routes: [
      { path: '/api/users/*', target: config.USER_SERVICE_URL },
      { path: '/api/orders/*', target: config.ORDER_SERVICE_URL },
      { path: '/api/payments/*', target: config.PAYMENT_SERVICE_URL },
    ],
    circuitBreakers: circuitBreakerRegistry.getAllStats(),
  });
});

// Live Circuit Breakers dashboard & monitoring endpoint
router.get('/health/circuit-breakers', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    circuitBreakers: circuitBreakerRegistry.getAllStats(),
  });
});

interface ServiceRoute {
  serviceName: string;
  pathPrefix: string;
  targetUrl: string;
  targetPrefix: string;
  description: string;
}

const serviceRoutes: ServiceRoute[] = [
  {
    serviceName: 'user-service',
    pathPrefix: '/api/users',
    targetUrl: config.USER_SERVICE_URL,
    targetPrefix: '/users',
    description: 'User Service - user accounts and profiles',
  },
  {
    serviceName: 'order-service',
    pathPrefix: '/api/orders',
    targetUrl: config.ORDER_SERVICE_URL,
    targetPrefix: '/orders',
    description: 'Order Service - orders and carts',
  },
  {
    serviceName: 'payment-service',
    pathPrefix: '/api/payments',
    targetUrl: config.PAYMENT_SERVICE_URL,
    targetPrefix: '/payments',
    description: 'Payment Service - transactions and billing',
  },
];

// Register each upstream service route with Phase 6 Reliability Proxy
for (const route of serviceRoutes) {
  const rewriteKey = `^${route.pathPrefix}`;
  const pathRewrite = { [rewriteKey]: route.targetPrefix };

  router.use(
    route.pathPrefix,
    createReliableProxy({
      serviceName: route.serviceName,
      targetUrl: route.targetUrl,
      pathRewrite,
    })
  );
}

export default router;
