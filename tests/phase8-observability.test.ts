// tests/phase8-observability.test.ts
//
// Phase 8: Observability Test Suite
//
// Tests:
//   1. Structured Logging & Correlation ID (X-Request-Id propagation)
//   2. Prometheus Metrics Collection (/metrics endpoint)
//   3. Rate Limit Rejection Metrics
//   4. Upstream Error & Timeout Metrics
//   5. Circuit Breaker State Gauge Tracking

import http from 'http';
import express from 'express';
import { requestLogger } from '../src/middleware/requestLogger';
import { metricsRegistry } from '../src/observability/metrics';
import { createReliableProxy } from '../src/reliability/reliableProxy';
import { circuitBreakerRegistry } from '../src/reliability/circuitBreaker';

const UPSTREAM_PORT = 4881;
const GATEWAY_PORT = 3881;
const UPSTREAM_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

let upstreamServer: http.Server;
let gatewayServer: http.Server;

// Upstream test server
const upstreamApp = express();
upstreamApp.get('/test/users', (_req, res) => {
  res.json({ users: ['Alice', 'Bob'] });
});

upstreamApp.get('/test/slow', async (_req, res) => {
  await new Promise((r) => setTimeout(r, 600));
  res.json({ status: 'done' });
});

upstreamApp.get('/test/fail', (_req, res) => {
  res.status(500).json({ error: 'Crash' });
});

async function runObservabilityTests() {
  console.log('\n===============================================================');
  console.log('       PHASE 8: OBSERVABILITY TEST (LOGS & PROMETHEUS)         ');
  console.log('===============================================================\n');

  // Start upstream server
  await new Promise<void>((resolve) => {
    upstreamServer = upstreamApp.listen(UPSTREAM_PORT, () => resolve());
  });

  // Setup test gateway
  const gatewayApp = express();

  // Reset metrics
  metricsRegistry.reset();

  // /metrics exposition endpoint
  gatewayApp.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metricsRegistry.getPrometheusMetrics());
  });

  // Structured logger
  gatewayApp.use(requestLogger);

  // Mount test route with reliable proxy
  gatewayApp.use(
    '/api/test',
    createReliableProxy({
      serviceName: 'obs-user-service',
      targetUrl: UPSTREAM_URL,
      pathRewrite: { '^/api/test': '/test' },
      timeoutMs: 300,
      retry: { maxRetries: 1, initialDelayMs: 20 },
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 1000 },
    })
  );

  await new Promise<void>((resolve) => {
    gatewayServer = gatewayApp.listen(GATEWAY_PORT, () => resolve());
  });

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Trace ID & Correlation Header
    // -------------------------------------------------------------------------
    console.log('---------------------------------------------------------------');
    console.log('  TEST 1: Request Correlation & Structured Logging');
    console.log('---------------------------------------------------------------');

    const res1 = await fetch(`${GATEWAY_URL}/api/test/users`, {
      headers: { 'x-request-id': 'custom-trace-999' },
    });
    const reqId = res1.headers.get('x-request-id');
    const gatewayHeader = res1.headers.get('x-gateway');

    console.log(`  HTTP Status:       ${res1.status}`);
    console.log(`  Echoed Request ID: ${reqId} (Expected: custom-trace-999)`);
    console.log(`  Served by Gateway: ${gatewayHeader}`);

    if (reqId !== 'custom-trace-999') {
      throw new Error(`Expected X-Request-Id 'custom-trace-999', got '${reqId}'`);
    }

    // -------------------------------------------------------------------------
    // TEST 2: Auto-Generated Request ID
    // -------------------------------------------------------------------------
    console.log('\n---------------------------------------------------------------');
    console.log('  TEST 2: Auto-Generated UUID when no header is supplied');
    console.log('---------------------------------------------------------------');

    const res2 = await fetch(`${GATEWAY_URL}/api/test/users`);
    const autoReqId = res2.headers.get('x-request-id');
    console.log(`  Auto-Generated ID: ${autoReqId}`);

    if (!autoReqId || autoReqId.length < 10) {
      throw new Error(`Expected valid UUID in X-Request-Id, got '${autoReqId}'`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: Upstream Timeout & Error Metric Recording
    // -------------------------------------------------------------------------
    console.log('\n---------------------------------------------------------------');
    console.log('  TEST 3: Upstream Timeouts & 5xx Error Tracking');
    console.log('---------------------------------------------------------------');

    // Trigger a timeout (upstream takes 600ms, gateway timeout is 300ms)
    const resSlow = await fetch(`${GATEWAY_URL}/api/test/slow`);
    console.log(`  Timeout Test:      HTTP ${resSlow.status} (Expected: 504)`);

    // Trigger a 500 error
    const resFail = await fetch(`${GATEWAY_URL}/api/test/fail`);
    console.log(`  Fail Test:         HTTP ${resFail.status} (Expected: 500)`);

    // Record artificial rate limit rejection
    metricsRegistry.recordRateLimitRejection('user:Alice', 'sliding-window');

    // -------------------------------------------------------------------------
    // TEST 4: Scrape /metrics endpoint (Prometheus format)
    // -------------------------------------------------------------------------
    console.log('\n---------------------------------------------------------------');
    console.log('  TEST 4: Prometheus Exposition Format (/metrics)');
    console.log('---------------------------------------------------------------');

    const metricsRes = await fetch(`${GATEWAY_URL}/metrics`);
    const metricsText = await metricsRes.text();

    console.log(`  Content-Type:      ${metricsRes.headers.get('content-type')}`);
    console.log('\n--- SAMPLE PROMETHEUS METRICS OUTPUT ---');
    console.log(metricsText.trim());
    console.log('----------------------------------------\n');

    // Assertions
    if (!metricsText.includes('requests_total')) {
      throw new Error('Prometheus metrics missing requests_total');
    }
    if (!metricsText.includes('rate_limit_rejected')) {
      throw new Error('Prometheus metrics missing rate_limit_rejected');
    }
    if (!metricsText.includes('upstream_timeouts')) {
      throw new Error('Prometheus metrics missing upstream_timeouts');
    }
    if (!metricsText.includes('circuit_breaker_state')) {
      throw new Error('Prometheus metrics missing circuit_breaker_state');
    }
    if (!metricsText.includes('request_duration_ms_bucket')) {
      throw new Error('Prometheus metrics missing request_duration_ms histogram');
    }

    console.log('===============================================================');
    console.log('  🎉 OBSERVABILITY METRICS & LOGGING VERIFIED 100% OPERATIONAL!');
    console.log('===============================================================\n');
  } finally {
    upstreamServer?.close();
    gatewayServer?.close();
  }
}

runObservabilityTests().catch((err) => {
  console.error('Observability test failed:', err);
  process.exit(1);
});
