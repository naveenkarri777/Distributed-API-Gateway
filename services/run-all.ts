// services/run-all.ts
//
// WHY THIS FILE EXISTS:
//   In Phase 2, we have 3 backend services (users, orders, payments).
//   Opening 4 separate terminal windows (3 backends + 1 gateway) can get tedious.
//   This helper script allows running all 3 backend microservices in a single terminal
//   using: npm run dev:services
//
//   You can still run any service individually if you prefer!

import { spawn } from 'child_process';
import path from 'path';

const tsxCli = path.resolve(__dirname, '../node_modules/tsx/dist/cli.mjs');

const services = [
  { name: 'user-service', script: path.resolve(__dirname, 'user-service/index.ts') },
  { name: 'order-service', script: path.resolve(__dirname, 'order-service/index.ts') },
  { name: 'payment-service', script: path.resolve(__dirname, 'payment-service/index.ts') },
];

console.log('Starting all backend microservices...\n');

for (const svc of services) {
  const child = spawn(process.execPath, [tsxCli, 'watch', svc.script], {
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    console.error(`[${svc.name}] Failed to start:`, err.message);
  });
}
