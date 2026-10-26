// services/redis-mock-server.ts
//
// Standalone Redis Mock Server (RESP Protocol over TCP):
//
// Speaks the Redis Serialization Protocol (RESP) over TCP on port 6379.
// Real ioredis clients connect to it exactly as if it were real Redis.
//
// Supported commands:
//   Strings:     PING, INFO, COMMAND, INCR, GET, SET, DEL, EXPIRE, TTL
//   Sorted Sets: ZADD, ZREMRANGEBYSCORE, ZCARD   ← added for Sliding Window
//   Hashes:      HMGET, HSET                     ← added for Token Bucket
//
// Storage model: Each Redis key has ONE type (string | zset | hash).
// Separate in-memory Maps handle each type.

import net from 'net';

const PORT = parseInt(process.env.REDIS_PORT ?? '6379', 10);

// ── Type definitions ─────────────────────────────────────────────────────────

interface StringRecord {
  type: 'string';
  value: string;
  expiresAt: number | null;
}

interface ZSetRecord {
  type: 'zset';
  members: Map<string, number>; // member → score
  expiresAt: number | null;
}

interface HashRecord {
  type: 'hash';
  fields: Map<string, string>; // field → value
  expiresAt: number | null;
}

type DBRecord = StringRecord | ZSetRecord | HashRecord;

const db = new Map<string, DBRecord>();

// ── Key Helpers ───────────────────────────────────────────────────────────────

function isExpired(rec: DBRecord): boolean {
  return rec.expiresAt !== null && Date.now() >= rec.expiresAt;
}

function getKey(key: string): DBRecord | undefined {
  const rec = db.get(key);
  if (!rec) return undefined;
  if (isExpired(rec)) {
    db.delete(key);
    return undefined;
  }
  return rec;
}

function setExpire(key: string, seconds: number): number {
  const rec = getKey(key);
  if (!rec) return 0;
  rec.expiresAt = Date.now() + seconds * 1000;
  return 1;
}

function getTTL(key: string): number {
  const rec = getKey(key);
  if (!rec) return -2;              // key does not exist
  if (rec.expiresAt === null) return -1;  // no expiry
  return Math.max(0, Math.ceil((rec.expiresAt - Date.now()) / 1000));
}

// ── RESP Parser ───────────────────────────────────────────────────────────────

function parseRESP(buffer: Buffer): string[][] {
  const str = buffer.toString('utf-8');
  const lines = str.split('\r\n');
  const commands: string[][] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('*')) {
      const numArgs = parseInt(line.substring(1), 10);
      const args: string[] = [];
      i++;
      for (let a = 0; a < numArgs && i < lines.length; a++) {
        if (lines[i].startsWith('$')) {
          i++;
          args.push(lines[i] ?? '');
          i++;
        } else {
          i++;
        }
      }
      if (args.length > 0) commands.push(args);
    } else if (line.trim().length > 0) {
      commands.push(line.trim().split(/\s+/));
      i++;
    } else {
      i++;
    }
  }

  return commands;
}

// ── Command Handlers ──────────────────────────────────────────────────────────

function handleCommand(cmdArgs: string[]): string {
  if (cmdArgs.length === 0) return '';
  const cmd = cmdArgs[0].toUpperCase();

  // ── Basic ──────────────────────────────────────────────────────────────────

  if (cmd === 'PING') return '+PONG\r\n';

  if (cmd === 'INFO') {
    const info = 'redis_version:7.0.0\r\nrole:master\r\n';
    return `$${info.length}\r\n${info}\r\n`;
  }

  if (cmd === 'COMMAND') return '*0\r\n';

  if (cmd === 'QUIT') return '+OK\r\n';

  // ── String commands ────────────────────────────────────────────────────────

  if (cmd === 'INCR') {
    const key = cmdArgs[1];
    let rec = getKey(key) as StringRecord | undefined;
    if (!rec) {
      rec = { type: 'string', value: '1', expiresAt: null };
    } else {
      if (rec.type !== 'string') return '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n';
      rec.value = String(parseInt(rec.value, 10) + 1);
    }
    db.set(key, rec);
    return `:${rec.value}\r\n`;
  }

  if (cmd === 'GET') {
    const key = cmdArgs[1];
    const rec = getKey(key) as StringRecord | undefined;
    if (!rec || rec.type !== 'string') return '$-1\r\n';
    return `$${rec.value.length}\r\n${rec.value}\r\n`;
  }

  if (cmd === 'SET') {
    const key = cmdArgs[1];
    const val = cmdArgs[2];
    let expiresAt: number | null = null;
    if (cmdArgs[3]?.toUpperCase() === 'EX' && cmdArgs[4]) {
      expiresAt = Date.now() + parseInt(cmdArgs[4], 10) * 1000;
    }
    db.set(key, { type: 'string', value: val, expiresAt });
    return '+OK\r\n';
  }

  if (cmd === 'DEL') {
    const key = cmdArgs[1];
    const existed = db.delete(key) ? 1 : 0;
    return `:${existed}\r\n`;
  }

  if (cmd === 'EXPIRE') {
    const key = cmdArgs[1];
    const seconds = parseInt(cmdArgs[2], 10);
    return `:${setExpire(key, seconds)}\r\n`;
  }

  if (cmd === 'TTL') {
    return `:${getTTL(cmdArgs[1])}\r\n`;
  }

  // ── Sorted Set commands (used by SlidingWindowLimiter) ─────────────────────
  //
  // A Sorted Set stores members each with a float score.
  // Members are unique; adding same member twice updates its score.
  // Members can be efficiently queried by score range.

  if (cmd === 'ZADD') {
    // ZADD key score member
    const key = cmdArgs[1];
    const score = parseFloat(cmdArgs[2]);
    const member = cmdArgs[3];

    let rec = getKey(key) as ZSetRecord | undefined;
    if (!rec) {
      rec = { type: 'zset', members: new Map(), expiresAt: null };
    } else if (rec.type !== 'zset') {
      return '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n';
    }
    const isNew = !rec.members.has(member) ? 1 : 0;
    rec.members.set(member, score);
    db.set(key, rec);
    return `:${isNew}\r\n`;   // returns count of NEW members added
  }

  if (cmd === 'ZREMRANGEBYSCORE') {
    // ZREMRANGEBYSCORE key min max
    // Remove all members whose score is between min and max (inclusive).
    const key = cmdArgs[1];
    const min = cmdArgs[2] === '-inf' ? -Infinity : parseFloat(cmdArgs[2]);
    const max = cmdArgs[3] === '+inf' ? Infinity : parseFloat(cmdArgs[3]);

    const rec = getKey(key) as ZSetRecord | undefined;
    if (!rec || rec.type !== 'zset') return ':0\r\n';

    let removed = 0;
    for (const [member, score] of rec.members) {
      if (score >= min && score <= max) {
        rec.members.delete(member);
        removed++;
      }
    }
    return `:${removed}\r\n`;
  }

  if (cmd === 'ZCARD') {
    // ZCARD key — return number of members in the sorted set
    const key = cmdArgs[1];
    const rec = getKey(key) as ZSetRecord | undefined;
    if (!rec || rec.type !== 'zset') return ':0\r\n';
    return `:${rec.members.size}\r\n`;
  }

  // ── Hash commands (used by TokenBucketLimiter) ─────────────────────────────
  //
  // A Hash stores field → value pairs under a single key.
  // Think of it like a nested object: key.field = value.

  if (cmd === 'HMGET') {
    // HMGET key field1 field2 ...
    // Returns array of values for each requested field (null if missing).
    const key = cmdArgs[1];
    const fields = cmdArgs.slice(2);
    const rec = getKey(key) as HashRecord | undefined;

    // Build a RESP array response
    let response = `*${fields.length}\r\n`;
    for (const field of fields) {
      const val = rec?.type === 'hash' ? rec.fields.get(field) : undefined;
      if (val === undefined) {
        response += '$-1\r\n';          // null bulk string = field not found
      } else {
        response += `$${val.length}\r\n${val}\r\n`;
      }
    }
    return response;
  }

  if (cmd === 'HSET') {
    // HSET key field1 value1 [field2 value2 ...]
    // Sets one or more fields. Returns count of NEW fields added.
    const key = cmdArgs[1];
    const pairs = cmdArgs.slice(2);  // [field1, value1, field2, value2, ...]

    let rec = getKey(key) as HashRecord | undefined;
    if (!rec) {
      rec = { type: 'hash', fields: new Map(), expiresAt: null };
    } else if (rec.type !== 'hash') {
      return '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n';
    }

    let newFields = 0;
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const field = pairs[i];
      const value = pairs[i + 1];
      if (!rec.fields.has(field)) newFields++;
      rec.fields.set(field, value);
    }
    db.set(key, rec);
    return `:${newFields}\r\n`;
  }

  // ── Legacy HMSET (deprecated in Redis 4+, but ioredis may send it) ─────────
  if (cmd === 'HMSET') {
    // HMSET key field1 value1 field2 value2 ...
    const key = cmdArgs[1];
    const pairs = cmdArgs.slice(2);

    let rec = getKey(key) as HashRecord | undefined;
    if (!rec) {
      rec = { type: 'hash', fields: new Map(), expiresAt: null };
    } else if (rec.type !== 'hash') {
      return '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n';
    }
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      rec.fields.set(pairs[i], pairs[i + 1]);
    }
    db.set(key, rec);
    return '+OK\r\n';
  }

  // Unknown command — return OK to avoid crashing ioredis handshake
  return '+OK\r\n';
}

// ── TCP Server ────────────────────────────────────────────────────────────────

const server = net.createServer((socket) => {
  socket.on('data', (data) => {
    const commands = parseRESP(data);
    for (const cmdArgs of commands) {
      if (cmdArgs.length === 0) continue;
      const response = handleCommand(cmdArgs);
      if (response) socket.write(response);

      // Handle QUIT cleanly
      if (cmdArgs[0]?.toUpperCase() === 'QUIT') socket.end();
    }
  });

  socket.on('error', () => {
    // Ignore client disconnect errors
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================================');
  console.log(`  Redis Mock Server running on port :${PORT}`);
  console.log('  Protocol: RESP (Redis Serialization Protocol)');
  console.log('  Supported: Strings, Sorted Sets, Hashes');
  console.log('  Algorithms: Fixed Window, Sliding Window, Token Bucket');
  console.log('========================================================');
  console.log('');
});
