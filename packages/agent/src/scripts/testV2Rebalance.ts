

import 'dotenv/config';

const AGENT_BASE = process.env.AGENT_BASE_URL ?? 'http://localhost:3001';

async function get(path: string): Promise<any> {
  const headers: any = {};
  if (process.env.AGENT_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.AGENT_API_KEY}`;
  }
  const res = await fetch(`${AGENT_BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function post(path: string, body: object): Promise<any> {
  const headers: any = { 'Content-Type': 'application/json' };
  if (process.env.AGENT_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.AGENT_API_KEY}`;
  }
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function short(s: string, n = 10) { return `${s.slice(0, n)}…`; }

async function main() {
  console.log('=== YieldGeko V2 Rebalance Test ===\n');

  
  console.log('1. Fetching agent state…');
  const state = await get('/state');
  const users  = Object.values(state.users ?? {}) as any[];
  const v2User = users.find((u: any) => u.policy?.isReal && u.policy?.signedDelegation);

  if (!v2User) {
    console.error('No real V2 user found. Register a strategy first.');
    process.exit(1);
  }

  const userId        = v2User.userId;
  const positions     = v2User.portfolio?.positions ?? [];
  const currentPos    = positions.find((p: any) => p.strategyType === 'DELTA_NEUTRAL');
  const phase         = v2User.phase;
  const managedUSD    = v2User.policy?.managedUSD ?? 1;

  console.log(`   userId:    ${userId}`);
  console.log(`   phase:     ${phase}`);
  console.log(`   position:  ${currentPos?.venueName ?? 'none'}`);
  console.log(`   tokenId:   ${currentPos?.uniV3TokenId ?? 'none'}`);
  console.log(`   managed:   $${managedUSD}\n`);

  if (!currentPos?.uniV3TokenId) {
    console.error('Current position has no tokenId — cannot migrate. Restart agent to backfill first.');
    process.exit(1);
  }

  if (phase !== 'MONITORING') {
    console.error(`Agent phase is ${phase}, expected MONITORING. Wait for agent to settle.`);
    process.exit(1);
  }

  
  console.log('2. Getting ranked opportunities…');
  const oppsRes = await get('/state');
  const opps    = (oppsRes.opportunities ?? []) as any[];

  if (opps.length < 2) {
    console.error('Not enough opportunities to migrate (need at least 2).');
    process.exit(1);
  }

  
  const currentVenueId = currentPos?.venueId ?? currentPos?.venueAddress;
  const candidates = opps.filter((o: any) =>
    o.strategyType === 'DELTA_NEUTRAL' &&
    o.address?.toLowerCase() !== currentPos?.venueAddress?.toLowerCase() &&
    o.id !== currentVenueId
  );

  if (candidates.length === 0) {
    console.error('No alternative DELTA_NEUTRAL pool found to migrate to.');
    process.exit(1);
  }

  const target = candidates[0];
  console.log(`   Current:  ${currentPos.venueName} @ ${currentPos.currentNetAPY?.toFixed(1) ?? '?'}% APY`);
  console.log(`   → Target: ${target.pool} @ ${target.netAPY?.toFixed(1) ?? '?'}% APY`);
  console.log(`   Address:  ${target.address}\n`);

  
  
  
  
  
  
  
  
  
  

  console.log('3. Triggering MIGRATE via agent execute API…');

  let migrateRes: any;
  try {
    migrateRes = await post('/api/force-migrate', {
      userId,
      targetPoolAddress: target.address,
      targetPoolName:    target.pool,
    });
    console.log('   ✓ Force-migrate accepted:', JSON.stringify(migrateRes));
  } catch (e: any) {
    
    console.log('   /api/force-migrate not available, using threshold override…');
    migrateRes = null;
  }

  if (!migrateRes) {
    
    console.log('   Patching migration threshold to 0% to force migrate on next tick…');
    try {
      await post('/api/patch-policy', {
        userId,
        migrationThresholdPct: 0,
      });
      console.log('   ✓ Migration threshold set to 0% — agent will migrate on next tick\n');
    } catch {
      console.log('   /api/patch-policy not available either.\n');
      console.log('   ── Manual trigger instructions ──────────────────────────────────');
      console.log(`   The agent will auto-migrate when APY uplift > migrationThresholdPct.`);
      console.log(`   Current best alternative: ${target.pool} @ ${target.netAPY?.toFixed(1)}%`);
      console.log(`   To force it: restart the agent with MIGRATION_THRESHOLD_PCT=0 env var.`);
      console.log('   ─────────────────────────────────────────────────────────────────\n');
    }
  }

  
  console.log('4. Polling agent state for migrate result (up to 3 minutes)…\n');
  const startTs    = Date.now();
  const timeoutMs  = 3 * 60 * 1000;
  let prevPhase    = phase;
  let migrated     = false;

  while (Date.now() - startTs < timeoutMs) {
    await sleep(5000);
    const snap = await get('/state');
    const u    = (Object.values(snap.users ?? {}) as any[]).find((x: any) => x.userId === userId);
    if (!u) continue;

    const newPhase    = u.phase;
    const newPos      = (u.portfolio?.positions ?? []).find((p: any) => p.strategyType === 'DELTA_NEUTRAL');
    const lastExec    = (u.executions ?? [])[0];
    const lastLog     = (u.log ?? []).slice(-1)[0];
    const elapsed     = ((Date.now() - startTs) / 1000).toFixed(0);

    if (newPhase !== prevPhase) {
      console.log(`   [${elapsed}s] Phase: ${prevPhase} → ${newPhase}`);
      prevPhase = newPhase;
    }

    if (lastLog) {
      console.log(`   [${elapsed}s] ${lastLog.level}: ${lastLog.message}`);
    }

    
    if (lastExec?.action === 'GENESIS' && lastExec.txHash &&
        newPos?.venueAddress?.toLowerCase() !== currentPos.venueAddress?.toLowerCase()) {
      console.log('\n=== MIGRATE SUCCESSFUL ===');
      console.log(`New position: ${newPos?.venueName}`);
      console.log(`Tx hash:      ${lastExec.txHash}`);
      if (lastExec.zgChainExplorer) {
        console.log(`0G proof:     ${lastExec.zgChainExplorer}`);
      }
      migrated = true;
      break;
    }

    
    const recentLogs = (u.log ?? []).slice(-5);
    const errorLog   = recentLogs.find((l: any) =>
      l.level === 'ERROR' && l.timestamp > startTs
    );
    if (errorLog) {
      console.log(`\n⚠ Error detected: ${errorLog.message}`);
      if (errorLog.detail) console.log(`  Detail: ${errorLog.detail}`);
      console.log('\nCheck agent logs for full error details.');
      break;
    }

    if (newPhase === 'MONITORING' && newPos && newPos.venueAddress !== currentPos.venueAddress) {
      migrated = true;
      break;
    }
  }

  if (!migrated) {
    const elapsed = ((Date.now() - startTs) / 1000).toFixed(0);
    console.log(`\n[${elapsed}s] Migration did not complete within timeout.`);
    console.log('Check agent logs: the migration may still be running or may have failed.');
  }

  
  console.log('\n5. Final state:');
  const finalState = await get('/state');
  const finalUser  = (Object.values(finalState.users ?? {}) as any[]).find((x: any) => x.userId === userId);
  if (finalUser) {
    const finalPos   = (finalUser.portfolio?.positions ?? [])[0];
    const finalExecs = (finalUser.executions ?? []).slice(0, 3);
    console.log(`   Phase:    ${finalUser.phase}`);
    console.log(`   Position: ${finalPos?.venueName ?? 'none'}`);
    console.log(`   tokenId:  ${finalPos?.uniV3TokenId ?? 'none'}`);
    console.log(`\n   Recent executions:`);
    for (const e of finalExecs) {
      const ts = new Date(e.timestamp).toLocaleTimeString();
      console.log(`   [${ts}] ${e.action} → ${e.to ?? 'n/a'} ${e.txHash ? `tx:${short(e.txHash)}` : '(simulated)'}`);
      if (e.zgChainTxHash) console.log(`          0G: ${e.zgChainExplorer}`);
    }
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
