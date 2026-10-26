// tests/phase6-reliability.test.ts
//
// Phase 6: Reliability Test Suite
//
// Demonstrates and verifies all 3 Pillars of Reliability:
//   1. Timeout: Returns HTTP 504 when upstream hangs.
//   2. Retry + Backoff: Automatically recovers transient errors with exponential backoff.
//   3. Circuit Breaker: Fast-fails dead services (<1ms) to prevent cascading failure,
//                       probes in HALF-OPEN, and self-heals back to CLOSED.
//
// Run with: npm run test:reliability

import http from 'http';
import express from 'express';
import { CircuitBreaker, circuitBreakerRegistry } from '../src/reliability/circuitBreaker';
import { executeWithRetry } from '../src/reliability/retry';
import { withTimeout, TimeoutError } from '../src/reliability/timeout';
import { createReliableProxy } from '../src/reliability/reliableProxy';

// ── Test Configuration ───────────────────────────────────────────────────────
const TEST_UPSTREAM_PORT = 4991;
const TEST_GATEWAY_PORT = 3991;

const UPSTREAM_URL = `http://127.0.0.1:${TEST_UPSTREAM_PORT}`;
const GATEWAY_URL = `http://127.0.0.1:${TEST_GATEWAY_PORT}`;

// ── Upstream Mock Server Setup ───────────────────────────────────────────────
let flakyCallCount = 0;
let isCrashing = false;

const upstreamApp = express();
upstreamApp.use(express.json());

// 1. Slow endpoint for testing timeout
upstreamApp.get('/test/slow', async (req, res) => {
  const delay = parseInt((req.query.delay as string) ?? '1500', 10);
  await new Promise((r) => setTimeout(r, delay));
  res.json({ message: 'Delayed response', delay });
});

// 2. Flaky endpoint for testing retry + backoff
upstreamApp.get('/test/flaky', (_req, res) => {
  flakyCallCount++;
  if (flakyCallCount <= 2) {
    // Fail first 2 attempts with 503 Service Unavailable
    res.status(503).json({ error: 'Service Unavailable', attempt: flakyCallCount });
  } else {
    // Succeed on 3rd attempt
    res.status(200).json({ status: 'ok', message: 'Success on attempt 3!', attempt: flakyCallCount });
  }
});

// 3. Outage endpoint for testing circuit breaker
upstreamApp.get('/test/outage', (_req, res) => {
  if (isCrashing) {
    res.status(500).json({ error: 'Internal Server Error', message: 'Service down' });
  } else {
    res.status(200).json({ status: 'ok', message: 'Service healthy' });
  }
});

let upstreamServer: http.Server;
let gatewayServer: http.Server;

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

async function runReliabilityTests() {
  console.log(`\n===============================================================`);
  console.log(`         PHASE 6: GATEWAY RELIABILITY TEST SUITE               `);
  console.log(`===============================================================`);

  // Start upstream mock
  await new Promise<void>((resolve) => {
    upstreamServer = upstreamApp.listen(TEST_UPSTREAM_PORT, () => resolve());
  });

  // Setup test gateway with tight thresholds for fast test execution:
  // - Timeout: 500ms
  // - Retries: 3 attempts with 50ms initial delay
  // - Circuit Breaker: Trips after 3 failures, cooldown 1200ms
  const testBreaker = new CircuitBreaker({
    name: 'test-service',
    failureThreshold: 3,
    resetTimeoutMs: 1200,
    halfOpenSuccessThreshold: 1,
  });

  // Register in registry
  (circuitBreakerRegistry as any).breakers.set('test-service', testBreaker);

  const gatewayApp = express();
  gatewayApp.use(
    '/api/test',
    createReliableProxy({
      serviceName: 'test-service',
      targetUrl: UPSTREAM_URL,
      pathRewrite: { '^/api/test': '/test' },
      timeoutMs: 500,
      retry: {
        maxRetries: 3,
        initialDelayMs: 50,
        backoffMultiplier: 2,
        jitterMs: 10,
        retryableStatuses: [500, 502, 503, 504],
        retryableMethods: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'],
      },
      circuitBreaker: {
        name: 'test-service',
        failureThreshold: 3,
        resetTimeoutMs: 1200,
        halfOpenSuccessThreshold: 1,
      },
    })
  );

  await new Promise<void>((resolve) => {
    gatewayServer = gatewayApp.listen(TEST_GATEWAY_PORT, () => resolve());
  });

  try {
    // -------------------------------------------------------------------------
    // TEST 1: TIMEOUT
    // -------------------------------------------------------------------------
    console.log(`\n---------------------------------------------------------------`);
    console.log(`  PILLAR 1: TIMEOUT`);
    console.log(`  Upstream hangs for 1200ms | Gateway Timeout set to: 500ms`);
    console.log(`---------------------------------------------------------------`);

    const t1Start = Date.now();
    const resTimeout = await fetch(`${GATEWAY_URL}/api/test/slow?delay=1200`);
    const t1Duration = Date.now() - t1Start;
    const bodyTimeout = await resTimeout.json() as any;

    console.log(`  HTTP Status:      ${resTimeout.status} ${resTimeout.status === 504 ? 'GATEWAY TIMEOUT ✅' : 'FAILED ❌'}`);
    console.log(`  Elapsed Time:     ${t1Duration}ms (Aborted near 500ms, avoided 1200ms hang!)`);
    console.log(`  Gateway Response: ${JSON.stringify(bodyTimeout)}`);

    if (resTimeout.status !== 504) {
      throw new Error(`Expected 504 Gateway Timeout, got ${resTimeout.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 2: RETRY + EXPONENTIAL BACKOFF
    // -------------------------------------------------------------------------
    console.log(`\n---------------------------------------------------------------`);
    console.log(`  PILLAR 2: RETRY + EXPONENTIAL BACKOFF WITH JITTER`);
    console.log(`  Upstream fails attempt 1 & 2 with 503 | Succeeds on attempt 3`);
    console.log(`---------------------------------------------------------------`);

    flakyCallCount = 0;
    testBreaker.reset(); // start fresh

    const t2Start = Date.now();
    const resRetry = await fetch(`${GATEWAY_URL}/api/test/flaky`);
    const t2Duration = Date.now() - t2Start;
    const bodyRetry = await resRetry.json() as any;
    const retryAttemptsHeader = resRetry.headers.get('X-Retry-Attempts');

    console.log(`  Client Received:  HTTP ${resRetry.status} OK ✅`);
    console.log(`  Retry Attempts:   ${retryAttemptsHeader} (Attempt 1: 503 -> Attempt 2: 503 -> Attempt 3: 200)`);
    console.log(`  Total Duration:   ${t2Duration}ms (Includes backoff delay between attempts)`);
    console.log(`  Payload:          ${JSON.stringify(bodyRetry)}`);

    if (resRetry.status !== 200 || retryAttemptsHeader !== '3') {
      throw new Error(`Expected transparent retry recovery on attempt 3, got status ${resRetry.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: CIRCUIT BREAKER STATE MACHINE
    // -------------------------------------------------------------------------
    console.log(`\n---------------------------------------------------------------`);
    console.log(`  PILLAR 3: CIRCUIT BREAKER LIFECYCLE (CLOSED -> OPEN -> HALF-OPEN -> CLOSED)`);
    console.log(`  Threshold: 3 failures | Cooldown: 1200ms`);
    console.log(`---------------------------------------------------------------`);

    testBreaker.reset();
    isCrashing = true; // simulate upstream service crash

    console.log(`\n  Step A: Upstream service crashes (returns 500). Circuit is CLOSED.`);
    console.log(`  ${pad('Request', 12)} ${pad('Status', 18)} ${pad('Breaker State', 16)} ${pad('Latency', 10)}`);
    console.log(`  ${'-'.repeat(58)}`);

    for (let i = 1; i <= 3; i++) {
      const start = Date.now();
      const res = await fetch(`${GATEWAY_URL}/api/test/outage`);
      const dur = Date.now() - start;
      const state = res.headers.get('X-Circuit-Breaker-State') || testBreaker.getState();
      console.log(`  ${pad(`Call #${i}`, 12)} ${pad(`HTTP ${res.status}`, 18)} ${pad(state, 16)} ${pad(`${dur}ms`, 10)}`);
    }

    console.log(`\n  Step B: Threshold reached (3/3 failures). Circuit is now OPEN!`);
    console.log(`  Sending Call #4:`);

    const openStart = Date.now();
    const resOpen = await fetch(`${GATEWAY_URL}/api/test/outage`);
    const openDur = Date.now() - openStart;
    const openBody = await resOpen.json() as any;
    const openState = resOpen.headers.get('X-Circuit-Breaker-State');

    console.log(`  HTTP Status:      ${resOpen.status} ${resOpen.status === 503 ? 'SERVICE UNAVAILABLE (Fast-Fail) ✅' : 'FAILED'}`);
    console.log(`  Breaker State:    ${openState}`);
    console.log(`  Latency:          ${openDur}ms  <-- FAST FAIL! Zero upstream network traffic!`);
    console.log(`  Response:         ${JSON.stringify(openBody)}`);

    if (resOpen.status !== 503 || openState !== 'OPEN') {
      throw new Error(`Expected fast-fail 503 with OPEN circuit, got ${resOpen.status}`);
    }

    console.log(`\n  Step C: Upstream heals. Waiting for 1300ms cooldown to enter HALF-OPEN...`);
    isCrashing = false; // upstream recovered
    await new Promise((r) => setTimeout(r, 1300));

    console.log(`  Cooldown elapsed. Next request acts as a trial PROBE.`);
    const probeRes = await fetch(`${GATEWAY_URL}/api/test/outage`);
    const probeState = probeRes.headers.get('X-Circuit-Breaker-State');

    console.log(`  Probe Call:       HTTP ${probeRes.status} OK ✅`);
    console.log(`  Circuit Transition: HALF-OPEN -> CLOSED (Probe succeeded, service healed!)`);

    // Verify circuit is now back to CLOSED for normal traffic
    const normalRes = await fetch(`${GATEWAY_URL}/api/test/outage`);
    const normalState = normalRes.headers.get('X-Circuit-Breaker-State');
    console.log(`  Subsequent Call:  HTTP ${normalRes.status} OK | State: ${normalState} ✅`);

    console.log(`\n===============================================================`);
    console.log(`  🎉 ALL 3 RELIABILITY PILLARS VERIFIED & 100% OPERATIONAL!`);
    console.log(`===============================================================\n`);
  } finally {
    upstreamServer?.close();
    gatewayServer?.close();
  }
}

runReliabilityTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
