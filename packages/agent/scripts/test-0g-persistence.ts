/**
 * End-to-end test: save a UserState to 0G Storage and restore it.
 * Run: pnpm --dir packages/agent exec ts-node scripts/test-0g-persistence.ts
 */

import * as dotenv from 'dotenv';
import * as path   from 'node:path';
import * as fs     from 'node:fs';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PersistenceStore } from '../src/orchestrator/persistence';
import type { UserState } from '../src/orchestrator/types';

const TEST_USER: UserState = {
  userId:     'test-persistence-001',
  policy: {
    id: 'test-persistence-001', displayName: 'Persistence Test',
    riskTier: 'balanced', managedUSD: 1_000,
    minAPY: 5, maxSlippageBps: 50, maxDrawdownPct: 10,
    maxFeeBps: 100, migrationThresholdPct: 3,
    createdAt: Date.now(), expiresAt: Date.now() + 86_400_000,
  },
  phase:      'MONITORING',
  position: {
    id: 'pos-test-001',
    venueId: 'gmx-0', venueName: 'GMX V2 ETH/USDC', protocol: 'GMX V2',
    strategyType: 'GMX_REAL_YIELD',
    entryAPY: 16.88, entryUSD: 1_000, entryTime: Date.now() - 86_400_000,
    currentAPY: 17.1, currentNetAPY: 16.93,
    currentUSD: 1_046.32, incomeEarnedUSD: 46.32,
    totalReturnUSD: 46.32, totalReturnPct: 4.632,
    effectiveAPY: 16.91, peakUSD: 1_047.15,
    drawdownPct: 0.08, daysHeld: 1, simulated: true,
  },
  breakers:   [],
  pnlHistory: [
    { ts: Date.now() - 3600_000, totalUSD: 1_020, navUSD: 1_020, incomeUSD: 20 },
    { ts: Date.now() - 1800_000, totalUSD: 1_033, navUSD: 1_033, incomeUSD: 33 },
    { ts: Date.now(),             totalUSD: 1_046, navUSD: 1_046, incomeUSD: 46 },
  ],
  executions: [{
    action: 'GENESIS', from: null, to: 'GMX V2 ETH/USDC',
    amountUSD: 1_000, simulated: true,
    receiptHash: '0xabc123', timestamp: Date.now() - 86_400_000,
  }],
  log: [{ id: 'log-1', timestamp: Date.now(), level: 'SUCCESS', message: 'Test entry' }],
  updatedAt:  Date.now(),
  tickErrors: 0,
};

async function run(): Promise<void> {
  console.log('\n🧪 YieldGeko 0G Storage Persistence Test\n');

  const store = new PersistenceStore();
  console.log(`   Mode: ${store.mode}\n`);

  // ── Save ────────────────────────────────────────────────────────────────
  console.log('▶ Saving test user state...');
  store.save(TEST_USER.userId, TEST_USER);

  console.log('⏳ Waiting for background upload to complete (up to 60s)...');
  const deadline = Date.now() + 60_000;
  while (store.pendingUploads > 0 && Date.now() < deadline) {
    process.stdout.write(`\r   Pending: ${store.pendingUploads} upload(s)...   `);
    await new Promise(r => setTimeout(r, 1_000));
  }
  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  if (store.pendingUploads > 0) {
    console.log('❌ Upload did not complete within 60s');
    process.exit(1);
  }

  const cidFile = path.resolve(process.cwd(), `.state/${TEST_USER.userId}.cid`);
  if (!fs.existsSync(cidFile)) {
    if (store.mode === 'local') {
      console.log('✅ Local mode — saved to .state/*.json (no CID)');
    } else {
      console.log('❌ 0G mode but no CID file found — upload may have failed');
      process.exit(1);
    }
  } else {
    const cid = fs.readFileSync(cidFile, 'utf8').trim();
    console.log(`✅ Saved — CID: ${cid}`);
  }

  // ── Restore ─────────────────────────────────────────────────────────────
  console.log('\n▶ Restoring...');
  const restored = await store.load(TEST_USER.userId);

  if (!restored) {
    console.log('❌ Restore returned null');
    process.exit(1);
  }

  // Verify key fields
  const checks = [
    ['userId',           restored.userId === TEST_USER.userId],
    ['phase',            restored.phase  === TEST_USER.phase],
    ['position exists',  restored.position !== null],
    ['position USD',     Math.abs((restored.position?.currentUSD ?? 0) - TEST_USER.position!.currentUSD) < 0.01],
    ['pnlHistory.length', restored.pnlHistory.length === TEST_USER.pnlHistory.length],
    ['executions.length', restored.executions.length === TEST_USER.executions.length],
    ['log.length',        restored.log.length === TEST_USER.log.length],
  ] as [string, boolean][];

  let allPassed = true;
  for (const [name, passed] of checks) {
    const icon = passed ? '✅' : '❌';
    console.log(`  ${icon} ${name}`);
    if (!passed) allPassed = false;
  }

  // Cleanup
  const stateDir = path.resolve(process.cwd(), '.state');
  const testFiles = [`${TEST_USER.userId}.cid`, `${TEST_USER.userId}.json`];
  for (const f of testFiles) {
    const p = path.join(stateDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  console.log(`\n${allPassed ? '🎉 All checks passed' : '❌ Some checks failed'}`);
  console.log(`Mode: ${store.mode} — 0G Storage ${store.mode === '0g' ? 'IS working ✅' : 'NOT used (local fallback)'}\n`);

  process.exit(allPassed ? 0 : 1);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
