// src/load-balancer/run-gateways.ts
//
// Multi-Gateway Launcher:
// Concurrently starts two isolated Gateway instances:
//   - Gateway-1 on port :3001
//   - Gateway-2 on port :3002

import { spawn } from 'child_process';
import path from 'path';

const tsxCli = path.resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');
const serverScript = path.resolve(__dirname, '../server.ts');

const instances = [
  { name: 'Gateway-1', port: '3001' },
  { name: 'Gateway-2', port: '3002' },
];

console.log('Spawning multiple Gateway instances...');

for (const inst of instances) {
  const child = spawn(process.execPath, [tsxCli, 'watch', serverScript], {
    env: {
      ...process.env,
      GATEWAY_PORT: inst.port,
      GATEWAY_INSTANCE_NAME: inst.name,
    },
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    console.error(`[${inst.name}] Failed to start:`, err.message);
  });
}
