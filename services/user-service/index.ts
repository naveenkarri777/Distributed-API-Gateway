// services/user-service/index.ts
//
// User Service Stub:
// Runs on port 4001. Handles user accounts and profiles.
// Serves /users/* independently without direct knowledge of the gateway.
// Includes Phase 6 reliability simulation routes (Timeout, Flakiness, Outages).

import express from 'express';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.USER_SERVICE_PORT ?? '4001', 10);

// In-memory data store for user profiles
const users: Record<string, { id: string; name: string; email: string }> = {
  '1':   { id: '1',   name: 'Alice',   email: 'alice@example.com' },
  '2':   { id: '2',   name: 'Bob',     email: 'bob@example.com' },
  '123': { id: '123', name: 'Charlie', email: 'charlie@example.com' },
};

// -------------------------------------------------------------
// Phase 6 Reliability Simulation Endpoints (For testing)
// -------------------------------------------------------------
let flakyCounter = 0;
let isCrashing = false;

// 1. Timeout Simulation: Hangs for ?ms=... before responding
app.get('/users/simulate/delay', async (req, res) => {
  const ms = parseInt((req.query.ms as string) ?? '2000', 10);
  console.log(`[user-service] [Simulate Timeout] Delaying response by ${ms}ms...`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  res.json({ status: 'ok', delayedMs: ms, message: 'Response after delay' });
});

// 2. Retry Simulation: Fails first N times with 503, then succeeds
app.get('/users/simulate/flaky', (req, res) => {
  const failTimes = parseInt((req.query.failTimes as string) ?? '2', 10);
  if (req.query.reset === 'true') {
    flakyCounter = 0;
    return res.json({ status: 'reset', flakyCounter: 0 });
  }

  flakyCounter++;
  if (flakyCounter <= failTimes) {
    console.warn(
      `[user-service] [Simulate Flaky] Failing call #${flakyCounter} with HTTP 503 (Transient Error)`
    );
    return res.status(503).json({
      error: 'Service Unavailable',
      attempt: flakyCounter,
      message: `Simulated transient failure on attempt ${flakyCounter}/${failTimes}`,
    });
  }

  console.log(
    `[user-service] [Simulate Flaky] Call #${flakyCounter} SUCCEEDED! Upstream recovered.`
  );
  const total = flakyCounter;
  flakyCounter = 0; // reset for next demo
  return res.json({
    status: 'ok',
    message: 'Flaky call successfully handled and recovered via Gateway Retry!',
    attemptsTaken: total,
  });
});

// 3. Circuit Breaker Simulation: Toggles a complete service crash (HTTP 500)
app.post('/users/simulate/toggle-crash', (req, res) => {
  isCrashing = req.body?.crashing ?? !isCrashing;
  console.log(`[user-service] [Simulate Crash] isCrashing toggled to: ${isCrashing}`);
  res.json({ isCrashing });
});

app.get('/users/simulate/unstable', (_req, res) => {
  if (isCrashing) {
    console.error('[user-service] [Simulate Crash] Responding with HTTP 500 (Outage)');
    return res.status(500).json({ error: 'Internal Server Error', message: 'User service is down' });
  }
  return res.json({ status: 'healthy', message: 'User service is operational' });
});

// -------------------------------------------------------------
// Standard User Service Endpoints
// -------------------------------------------------------------

// GET /users -> list all users
app.get('/users', (_req, res) => {
  console.log('[user-service] GET /users');
  res.json({ users: Object.values(users) });
});

// GET /users/:id -> get single user by ID
app.get('/users/:id', (req, res) => {
  console.log(`[user-service] GET /users/${req.params.id}`);
  const user = users[req.params.id];
  if (!user) {
    return res.status(404).json({ error: 'User not found', id: req.params.id });
  }
  return res.json({ user });
});

// POST /users -> create a new user
app.post('/users', (req, res) => {
  console.log('[user-service] POST /users', req.body);
  const { name, email } = req.body as { name?: string; email?: string };
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  const id = String(Date.now());
  users[id] = { id, name, email };
  return res.status(201).json({ user: users[id] });
});

app.listen(PORT, () => {
  console.log(`[user-service] Running on port :${PORT}`);
  console.log('[user-service] Routes: GET /users, GET /users/:id, POST /users');
  console.log('[user-service] Simulation: /users/simulate/delay, /users/simulate/flaky, /users/simulate/unstable');
});
