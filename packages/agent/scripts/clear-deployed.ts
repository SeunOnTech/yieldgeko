/**
 * Clear phantom vault.deployed[user][USDC] — for situations where
 * deployed tracking accumulated without a matching close call.
 *
 * Uses executeWithdrawMulti([USDC], [phantomAmount], nftMgr, multicall([]))
 * The NftManager.multicall([]) is a valid no-op: no USDC moves, so
 * returned=0, toDeduct=phantomAmount, deployed[user][USDC] → 0.
 *
 * Usage:
 *   cd packages/agent && npx ts-node scripts/clear-deployed.ts
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path   from 'node:path';
import { getExecutor } from '../src/orchestrator/execution';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ARB_RPC     = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const VAULT_ADDR  = process.env.VAULT_ADDRESS!;
const USER_ADDR   = process.env.TEST_USER_ADDRESS!;
const USDC        = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const NFT_MGR     = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

const VAULT_ABI = ['function deployed(address,address) view returns (uint256)'];
const NFT_MULTICALL_IFACE = new ethers.Interface(['function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)']);
const EXEC_WITHDRAW_MULTI_ABI = ['function executeWithdrawMulti(address user, address[] calldata assets, uint256[] calldata deployedAmounts, address target, bytes calldata data, bytes32 receiptHash) external payable returns (uint256[] memory)'];

async function main() {
  const provider    = new ethers.JsonRpcProvider(ARB_RPC, 42161, { staticNetwork: true });
  const vaultRead   = new ethers.Contract(VAULT_ADDR, VAULT_ABI, provider);
  const phantomRaw  = await vaultRead.deployed(USER_ADDR, USDC) as bigint;
  const phantom     = Number(phantomRaw) / 1e6;

  console.log(`Phantom deployed[user][USDC]: $${phantom.toFixed(6)}`);

  if (phantomRaw === 0n) {
    console.log('Nothing to clear. Exiting.');
    return;
  }

  const executor = getExecutor();
  if (!executor) throw new Error('AGENT_PRIVATE_KEY / VAULT_ADDRESS not set');
  await (executor as any).pimlicoInit;

  // No-op calldata: NftManager.multicall([]) — empty array, always succeeds
  const noopCalldata = NFT_MULTICALL_IFACE.encodeFunctionData('multicall', [[]]);

  // Build receiptHash (arbitrary — just needs to be unique)
  const receiptHash = ethers.keccak256(
    ethers.toUtf8Bytes(`clear-deployed-${USER_ADDR}-${Date.now()}`),
  );

  console.log(`Calling executeWithdrawMulti([USDC], [${phantomRaw}], nftMgr, multicall([]))...`);

  const { txHash } = await (executor as any)._submitVaultTx('executeWithdrawMulti', [
    USER_ADDR,
    [USDC],
    [phantomRaw],
    NFT_MGR,
    noopCalldata,
    receiptHash,
  ]);

  console.log(`✅ Tx: ${txHash}`);

  const after = await vaultRead.deployed(USER_ADDR, USDC) as bigint;
  console.log(`deployed[user][USDC] after: $${(Number(after) / 1e6).toFixed(6)}`);

  if (after === 0n) {
    console.log('✅ Phantom cleared — vault.deployed[user][USDC] = 0');
  } else {
    console.log(`⚠ Still has $${(Number(after)/1e6).toFixed(6)} — manual check needed`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
