#!/usr/bin/env node
// Prints fresh random values for the three HQ secrets. Run once, paste into .dev.vars.
import { randomBytes } from 'node:crypto';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
console.log(`HQ_MASTER_KEY=${randomBytes(32).toString('base64')}`);
console.log(`HQ_SYNC_SECRET=${b64url(randomBytes(32))}`);
console.log(`HQ_INGEST_KEY=hqi_${b64url(randomBytes(32))}`);
