

import 'dotenv/config';
import { uploadExecutionTrace }  from '../orchestrator/persistence';
import { anchorExecutionProof }  from '../orchestrator/zgChain';
import { generateTEEAttestation } from '../orchestrator/teeIntelligence';

const TEST_USER    = '0x092106703adE19BF7a638AD371f8f6c25831F349';
const TEST_RECEIPT = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

function section(title: string) {
  console.log(`\n${'─'.repeat(52)}\n  ${title}\n${'─'.repeat(52)}\n`);
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  YieldGeko — 0G Infrastructure Smoke Test');
  console.log('══════════════════════════════════════════════════\n');

  console.log('  Env check:');
  console.log(`    RPC_URL:                  ${process.env.RPC_URL ?? '(missing)'}`);
  console.log(`    INDEXER_URL:              ${process.env.INDEXER_URL ?? '(missing)'}`);
  console.log(`    FLOW_ADDR:                ${process.env.FLOW_ADDR ?? '(missing)'}`);
  console.log(`    ZG_REGISTRY_ADDRESS:      ${process.env.ZG_REGISTRY_ADDRESS ?? '❌ MISSING'}`);
  console.log(`    PRIVATE_KEY:              ${process.env.PRIVATE_KEY ? '✅ set' : '❌ MISSING'}`);
  console.log(`    ZG_COMPUTE_PROVIDER_ADDRESS: ${process.env.ZG_COMPUTE_PROVIDER_ADDRESS ?? '(missing)'}`);
  console.log(`    ZG_COMPUTE_MODEL:         ${process.env.ZG_COMPUTE_MODEL ?? '(missing)'}`);

  

  section('[1] 0G Storage — upload execution trace');

  let traceCID: string | null = null;
  try {
    traceCID = await uploadExecutionTrace({
      action:         'REGISTER',
      userId:         'debug-test',
      userAddress:    TEST_USER,
      receiptHash:    TEST_RECEIPT,
      arbitrumTxHash: '0x' + '00'.repeat(32),
      timestamp:      Date.now(),
      poolAddress:    '',
      amountUSD:      1,
      screenerTop5:   [],
      teeDecision:    { action: 'REGISTER', reason: '0G infra smoke test', upliftPct: 0 },
    });
    if (traceCID) {
      console.log(`  ✅ Trace uploaded`);
      console.log(`     CID:      ${traceCID}`);
      console.log(`     StorageScan: https://storagescan.0g.ai/submission/${traceCID}`);
    } else {
      console.log(`  ⚠️  Upload returned null (check INDEXER_URL / FLOW_ADDR / PRIVATE_KEY)`);
    }
  } catch (err: any) {
    console.log(`  ❌ Upload failed: ${err.message?.slice(0, 120)}`);
  }

  

  section('[2] 0G Chain — anchor in YieldGekoRegistry');

  try {
    const anchor = await anchorExecutionProof({
      receiptHash: TEST_RECEIPT,
      userAddress: TEST_USER,
      action:      'REGISTER',
      traceCID:    traceCID ?? '',
      attestCID:   '',
    });
    if (anchor) {
      console.log(`  ✅ Anchored on 0G Chain`);
      console.log(`     TX:       ${anchor.txHash}`);
      console.log(`     Explorer: ${anchor.explorerUrl}`);
    } else {
      console.log(`  ⚠️  Anchor returned null`);
      console.log(`     Check: ZG_REGISTRY_ADDRESS, PRIVATE_KEY, RPC_URL`);
    }
  } catch (err: any) {
    console.log(`  ❌ Anchor failed: ${err.message?.slice(0, 120)}`);
  }

  

  section('[3] 0G Compute TEE — DeepSeek V3 attestation');

  try {
    const tee = await generateTEEAttestation({
      opportunities: [],
      decision:      { action: 'GENESIS', reason: 'smoke test', upliftPct: 0, targetOpportunity: null, currentOpportunity: null },
      userId:        'debug-test',
      userAddress:   TEST_USER,
      receiptHash:   TEST_RECEIPT,
    });
    if (tee) {
      console.log(`  ✅ TEE attestation generated`);
      console.log(`     attestCID:  ${tee.attestCID}`);
      console.log(`     mode:       ${tee.mode}`);
      if (tee.attestCID) {
        console.log(`     StorageScan: https://storagescan.0g.ai/submission/${tee.attestCID}`);
      }
    } else {
      console.log(`  ⚠️  TEE returned null (check ZG_COMPUTE_PROVIDER_ADDRESS)`);
    }
  } catch (err: any) {
    console.log(`  ❌ TEE failed: ${err.message?.slice(0, 120)}`);
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log('  Done — check each component above');
  console.log('══════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('[FATAL]', err?.message ?? err);
  process.exit(1);
});
