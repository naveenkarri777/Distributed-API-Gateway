// tests/rateLimiter.test.ts
//
// Unit Tests: In-Memory Fixed Window Rate Limiter (Phase 3 baseline)

import { InMemoryRateLimiter } from '../src/services/rateLimitService';

async function runTests() {
  console.log('Starting Rate Limiter Unit Tests...\n');

  const WINDOW_MS = 1000;
  const MAX_REQUESTS = 3;
  const limiter = new InMemoryRateLimiter(WINDOW_MS, MAX_REQUESTS);

  // Test 1: Quota consumption within limit
  console.log('Test 1: Requests within limit should be allowed');
  const res1 = limiter.consume('user:alice');
  console.assert(res1.allowed === true, 'Req 1 should be allowed');
  console.assert(res1.remaining === 2, `Req 1 remaining should be 2, got ${res1.remaining}`);

  const res2 = limiter.consume('user:alice');
  console.assert(res2.allowed === true, 'Req 2 should be allowed');
  console.assert(res2.remaining === 1, `Req 2 remaining should be 1, got ${res2.remaining}`);

  const res3 = limiter.consume('user:alice');
  console.assert(res3.allowed === true, 'Req 3 should be allowed');
  console.assert(res3.remaining === 0, `Req 3 remaining should be 0, got ${res3.remaining}`);
  console.log('  [PASS] Test 1: 3 requests allowed, remaining counted down to 0');

  // Test 2: Request exceeding limit should be rejected
  console.log('\nTest 2: Request exceeding limit should be rejected (429)');
  const res4 = limiter.consume('user:alice');
  console.assert(res4.allowed === false, 'Req 4 should be rejected');
  console.assert(res4.remaining === 0, `Req 4 remaining should be 0, got ${res4.remaining}`);
  console.assert(res4.retryAfterSeconds >= 1, 'retryAfter should be >= 1s');
  console.log('  [PASS] Test 2: 4th request blocked with allowed=false');

  // Test 3: Client isolation (Bob should not be affected by Alice)
  console.log('\nTest 3: Different client (Bob) should have independent quota');
  const resBob = limiter.consume('user:bob');
  console.assert(resBob.allowed === true, 'Bob req 1 should be allowed even if Alice is blocked');
  console.assert(resBob.remaining === 2, `Bob remaining should be 2, got ${resBob.remaining}`);
  console.log('  [PASS] Test 3: Bob has independent limit from Alice');

  // Test 4: Window reset after expiry
  console.log('\nTest 4: Window resets after expiry time');
  console.log('  Waiting 1100ms for window to expire...');
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const resAliceNewWindow = limiter.consume('user:alice');
  console.assert(resAliceNewWindow.allowed === true, 'Alice should be allowed after window resets');
  console.assert(resAliceNewWindow.remaining === 2, `Alice remaining should reset to 2, got ${resAliceNewWindow.remaining}`);
  console.log('  [PASS] Test 4: Alice quota restored after window reset');

  console.log('\nALL RATE LIMITER TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('[FAIL] Test failed:', err);
  process.exit(1);
});
