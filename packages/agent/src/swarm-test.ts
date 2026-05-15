
import { ethers } from 'ethers';
import PQueue from 'p-queue';
import { LedgerLogger } from './storage/ledger-logger';
import { fetchPendleMarketYield } from './parsers/pendle';
import { fetchAaveUSDCSupplyAPY } from './parsers/aave-v3';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const CONCURRENCY = 3; 
const TOTAL_USERS = 50;

async function runSwarmTest() {
    console.log("🦎 YIELDGEKO SWARM TEST: 50 CONCURRENT USERS");
    console.log("===========================================");

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
    const queue = new PQueue({ concurrency: CONCURRENCY });

    const metrics = {
        success: 0,
        failed: 0,
        totalGasUSDC: 0,
        zeroGSuccess: 0
    };

    
    console.log("[Setup] Fetching live market conditions...");
    const [pendle, aave] = await Promise.all([
        fetchPendleMarketYield(),
        fetchAaveUSDCSupplyAPY()
    ]);
    const currentApy = Number(aave.apyBps) / 100;
    const targetApy = Number(pendle.impliedApyBps) / 100;
    console.log(`[Market] Current: ${currentApy}%, Target: ${targetApy}%`);

    
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || 100000000n; 
    console.log(`[Gas] Current Price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);

    
    const processMigration = async (userId: string) => {
        try {
            
            
            const estimatedGasLimit = 150000n;
            const gasCostEth = gasPrice * estimatedGasLimit;
            const ethPrice = 2500n; 
            const gasCostUSDC = (gasCostEth * ethPrice) / 10n**18n; 
            
            
            const amount = BigInt(Math.floor(Math.random() * 5000) + 1000) * 10n**6n; 
            const fees = {
                migration: (amount * 10n) / 10000n,
                success: (amount * 25n) / 10000n,
                gas: gasCostUSDC
            };

            
            const { cid } = await LedgerLogger.logAction(
                'MIGRATION',
                { id: userId },
                { id: 'pendle-weeth', name: 'Pendle weETH', apy: Math.floor(targetApy * 100) },
                { id: 'aave-v3-usdc', apy: Math.floor(currentApy * 100) },
                amount,
                fees,
                wallet as any,
                process.env.INDEXER_URL!,
                process.env.RPC_URL!
            );

            metrics.zeroGSuccess++;
            metrics.totalGasUSDC += Number(gasCostUSDC);
            metrics.success++;
            console.log(`[User ${userId}] ✅ Migration Anchored. CID: ${cid.slice(0, 10)}...`);
        } catch (err: any) {
            metrics.failed++;
            console.error(`[User ${userId}] ❌ Failed:`, err.message || err);
        }
    };

    
    console.log(`\n[Queue] Dispatching ${TOTAL_USERS} migration requests...`);
    const startTime = Date.now();
    
    const tasks = Array.from({ length: TOTAL_USERS }, (_, i) => {
        return queue.add(() => processMigration(`User_${i + 1}`));
    });

    await Promise.all(tasks);

    const duration = (Date.now() - startTime) / 1000;

    
    console.log("\n===========================================");
    console.log("🦎 SWARM TEST COMPLETE");
    console.log("===========================================");
    console.log(`Total Time:      ${duration.toFixed(2)}s`);
    console.log(`Concurrency:     ${CONCURRENCY}`);
    console.log(`Success Rate:    ${metrics.success}/${TOTAL_USERS} (${(metrics.success/TOTAL_USERS*100).toFixed(1)}%)`);
    console.log(`0G Anchors:      ${metrics.zeroGSuccess}`);
    console.log(`Estimated Gas:   $${metrics.totalGasUSDC.toFixed(2)} USDC`);
    console.log("===========================================");
}

runSwarmTest().catch(console.error);
