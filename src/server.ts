// src/server.ts
//
// Gateway Entry Point:
// Starts the HTTP server on GATEWAY_PORT.

import app from './app';
import { config } from './config/env';

app.listen(config.GATEWAY_PORT, () => {
  console.log('');
  console.log('========================================================');
  console.log(`  API Gateway running on port :${config.GATEWAY_PORT}`);
  console.log(`  Rate Limiting Algorithm: ${config.RATE_LIMIT_ALGORITHM}`);
  console.log(`    Limit: ${config.RATE_LIMIT_MAX_REQUESTS} requests per ${config.RATE_LIMIT_WINDOW_MS / 1000}s`);
  console.log(`    Store: Redis (${config.REDIS_URL})`);
  console.log('  Upstream Routes:');
  console.log(`    GET /health        -> Gateway Health Check`);
  console.log(`    /api/users/*       -> User Service    (${config.USER_SERVICE_URL})`);
  console.log(`    /api/orders/*      -> Order Service   (${config.ORDER_SERVICE_URL})`);
  console.log(`    /api/payments/*    -> Payment Service (${config.PAYMENT_SERVICE_URL})`);
  console.log('========================================================');
  console.log('');
});

