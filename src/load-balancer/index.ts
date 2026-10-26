// src/load-balancer/index.ts
//
// Round-Robin Load Balancer:
// Sits in front of multiple API Gateway instances.
// Listens on public port (3000) and alternates traffic between:
//   - Gateway-1 (http://localhost:3001)
//   - Gateway-2 (http://localhost:3002)

import express, { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { ServerResponse } from 'http';
import { randomUUID } from 'crypto';

const app = express();
const LB_PORT = parseInt(process.env.LB_PORT ?? '3000', 10);

interface GatewayTarget {
  name: string;
  url: string;
}

const gatewayPool: GatewayTarget[] = [
  { name: 'Gateway-1', url: process.env.GATEWAY_1_URL ?? 'http://localhost:3001' },
  { name: 'Gateway-2', url: process.env.GATEWAY_2_URL ?? 'http://localhost:3002' },
];

let currentIndex = 0;

/**
 * Returns the next gateway in round-robin order.
 */
function getNextGateway(): GatewayTarget {
  const target = gatewayPool[currentIndex];
  currentIndex = (currentIndex + 1) % gatewayPool.length;
  return target;
}

// Health check endpoint for the load balancer
app.get('/lb-status', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'load-balancer',
    algorithm: 'round-robin',
    activeGateways: gatewayPool,
  });
});

// Distribute incoming requests across the gateway pool
app.use((req: Request, res: Response, next) => {
  const chosenGateway = getNextGateway();

  // 1. Trace Propagation: Generate or reuse Request ID
  const incomingId = req.headers['x-request-id'];
  const requestId = Array.isArray(incomingId)
    ? incomingId[0]
    : incomingId || randomUUID();

  // Set correlation headers
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Served-By', chosenGateway.name);

  console.log(
    `[LoadBalancer :${LB_PORT}] requestId=${requestId} ${req.method} ${req.url} -> ${chosenGateway.name} (${chosenGateway.url})`
  );

  const proxy = createProxyMiddleware({
    target: chosenGateway.url,
    changeOrigin: true,
    headers: {
      'x-request-id': requestId,
    },
    on: {
      error: (err, _pReq, pRes) => {
        console.error(`[LoadBalancer Error] Failed to reach ${chosenGateway.name}: ${err.message}`);
        const serverRes = pRes as ServerResponse;
        if (!serverRes.headersSent) {
          const body = JSON.stringify({
            error: 'Service Unavailable',
            message: `Load balancer could not reach upstream ${chosenGateway.name} at ${chosenGateway.url}`,
          });
          serverRes.writeHead(503, { 'Content-Type': 'application/json' });
          serverRes.end(body);
        }
      },
    },
  });

  proxy(req, res, next);
});

app.listen(LB_PORT, () => {
  console.log('');
  console.log('========================================================');
  console.log(`  Load Balancer running on :${LB_PORT}`);
  console.log('  Algorithm: Round-Robin');
  console.log('  Gateway Pool:');
  for (const gw of gatewayPool) {
    console.log(`    * ${gw.name.padEnd(12)} -> ${gw.url}`);
  }
  console.log('========================================================');
  console.log('');
});
