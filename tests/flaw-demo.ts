// tests/flaw-demo.ts
//
// Demonstration: In-Memory Rate Limiting Flaw across Multiple Gateway Instances
// Proves why isolated process memory fails when scaled to multiple gateway nodes.

async function demonstrateFlaw() {
  console.log('=======================================================================');
  console.log('EXPERIMENT: Testing In-Memory Rate Limiter with 2 Gateway Instances');
  console.log('=======================================================================');
  console.log('Configuration:');
  console.log('  Rate Limit: 5 requests / 60 seconds');
  console.log('  Client: Alice');
  console.log('  Target: Load Balancer (http://localhost:3000)');
  console.log('  Sending: 10 requests\n');

  const LB_URL = 'http://localhost:3000';
  let allowedCount = 0;
  let blockedCount = 0;

  for (let i = 1; i <= 10; i++) {
    try {
      const res = await fetch(`${LB_URL}/api/users/123`, {
        headers: { 'X-User-Id': 'Alice' },
      });

      const servedBy = res.headers.get('x-served-by') ?? 'Unknown';
      const remaining = res.headers.get('x-ratelimit-remaining') ?? 'N/A';
      const limit = res.headers.get('x-ratelimit-limit') ?? 'N/A';

      if (res.status === 200) {
        allowedCount++;
        console.log(
          `  Req #${String(i).padStart(2)}: HTTP 200 OK | Handled By: ${servedBy.padEnd(9)} | Remaining on node: ${remaining}/${limit}`
        );
      } else if (res.status === 429) {
        blockedCount++;
        console.log(
          `  Req #${String(i).padStart(2)}: HTTP 429 REJECTED | Handled By: ${servedBy.padEnd(9)} | Blocked by this node`
        );
      } else {
        console.log(`  Req #${String(i).padStart(2)}: HTTP ${res.status} | Handled By: ${servedBy}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Req #${i} failed to connect:`, message);
    }
  }

  console.log('\n-----------------------------------------------------------------------');
  console.log('RESULTS SUMMARY:');
  console.log(`  Total Requests Sent: 10`);
  console.log(`  Allowed (HTTP 200):  ${allowedCount}`);
  console.log(`  Blocked (HTTP 429):  ${blockedCount}`);
  console.log('-----------------------------------------------------------------------');

  if (allowedCount > 5) {
    console.log('\n[FLAW PROVEN] Rate Limit Bypassed:');
    console.log(`  Alice was supposed to be limited to 5 requests.`);
    console.log(`  Instead, Alice made ${allowedCount} requests because Gateway-1 and Gateway-2`);
    console.log(`  do not share memory. Each gateway has its own isolated Map.`);
    console.log('\nSolution (Phase 4):');
    console.log(`  Centralize state into Redis so all gateway instances share one atomic counter.\n`);
  } else {
    console.log('\n[PASS] Rate limit strictly enforced.\n');
  }
}

demonstrateFlaw().catch(console.error);
