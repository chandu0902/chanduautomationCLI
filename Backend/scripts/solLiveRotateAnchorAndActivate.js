#!/usr/bin/env node
'use strict';

/**
 * Calls POST /api/sol-runner/live/bots/rotate-anchor on the running backend so the
 * live runner is stopped/flattened and restarted in-process with a new bot row.
 *
 * Usage:
 *   cd Backend && node scripts/solLiveRotateAnchorAndActivate.js
 *   node scripts/solLiveRotateAnchorAndActivate.js --from=5 --name="SOL regrid"
 *
 * Env: PORT (default 3001), BACKEND_URL optional full origin (e.g. http://127.0.0.1:3001)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
  const argv = process.argv.slice(2);
  const fromArg = argv.find((a) => /^--from=\d+$/.test(a));
  const nameArg = argv.find((a) => /^--name=/.test(a));
  const sourceBotId = fromArg ? parseInt(fromArg.split('=')[1], 10) : undefined;
  const name = nameArg ? nameArg.slice('--name='.length) : undefined;

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'Usage: node scripts/solLiveRotateAnchorAndActivate.js [--from=<activeBotId>] [--name="..."]\n' +
        'Requires the Fastify backend to be listening (uses BACKEND_URL or http://127.0.0.1:PORT).',
    );
    process.exit(0);
  }

  const port = process.env.PORT || 3001;
  const base = String(process.env.BACKEND_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');
  const body = {};
  if (Number.isFinite(sourceBotId) && sourceBotId > 0) body.sourceBotId = sourceBotId;
  if (name && String(name).trim()) body.name = String(name).trim();

  const res = await fetch(`${base}/api/sol-runner/live/bots/rotate-anchor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    console.error(res.status, text);
    process.exit(1);
  }
  console.log(JSON.stringify(j, null, 2));
  if (!j.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
