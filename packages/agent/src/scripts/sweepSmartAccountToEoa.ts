

import 'dotenv/config';
import {
  createPublicClient, http, encodeFunctionData, parseAbi, formatUnits,
  type Address, type Hex,
} from 'viem';
import { arbitrum } from 'viem/chains';
import { createBundlerClient }      from 'viem/account-abstraction';
import { privateKeyToAccount }      from 'viem/accounts';
import { createPimlicoClient }      from 'permissionless/clients/pimlico';
import { Implementation, toMetaMaskSmartAccount } from '@metamask/smart-accounts-kit';

const ROUTER  = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as Address;
const WBTC    = '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as Address;
const USDT    = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as Address;
const USDC    = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;

const ERC20_ABI  = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const ROUTER_ABI = parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)']);

async function main() {
  const ARB_RPC    = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
  const PIMLICO_URL = `https://api.pimlico.io/v2/42161/rpc?apikey=${process.env.PIMLICO_API_KEY}`;
  const USER_KEY   = process.env.TEST_USER_PRIVKEY as Hex;

  if (!USER_KEY) throw new Error('TEST_USER_PRIVKEY not set in .env');

  const publicClient  = createPublicClient({ chain: arbitrum, transport: http(ARB_RPC) });
  const pimlicoClient = createPimlicoClient({
    transport: http(PIMLICO_URL),
    entryPoint: { address: ENTRY_POINT, version: '0.7' },
  });

  const userAccount = privateKeyToAccount(USER_KEY);
  const smartAcct   = await toMetaMaskSmartAccount({
    client: publicClient, implementation: Implementation.Hybrid,
    deployParams: [userAccount.address, [], [], []] as const,
    deploySalt: '0x', signer: { account: userAccount },
  });

  const eoaAddress  = userAccount.address;
  const saAddress   = smartAcct.address;

  console.log(`\nSmart account: ${saAddress}`);
  console.log(`EOA (recipient): ${eoaAddress}`);

  const [wbtcBal, usdtBal] = await Promise.all([
    publicClient.readContract({ address: WBTC, abi: ERC20_ABI, functionName: 'balanceOf', args: [saAddress] }),
    publicClient.readContract({ address: USDT, abi: ERC20_ABI, functionName: 'balanceOf', args: [saAddress] }),
  ]);

  console.log(`\nBalances:`);
  console.log(`  WBTC: ${formatUnits(wbtcBal, 8)} (${wbtcBal})`);
  console.log(`  USDT: ${formatUnits(usdtBal, 6)} (${usdtBal})`);

  const calls: { to: Address; value: bigint; data: Hex }[] = [];

  if (wbtcBal > 0n) {
    calls.push({ to: WBTC, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, wbtcBal] }) });
    calls.push({ to: ROUTER, value: 0n, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: WBTC, tokenOut: USDC, fee: 3000, recipient: eoaAddress, amountIn: wbtcBal, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) });
  }

  if (usdtBal > 0n) {
    calls.push({ to: USDT, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, usdtBal] }) });
    calls.push({ to: ROUTER, value: 0n, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: USDT, tokenOut: USDC, fee: 500, recipient: eoaAddress, amountIn: usdtBal, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) });
  }

  if (calls.length === 0) { console.log('\nNothing to sweep.'); return; }

  const bundlerClient = createBundlerClient({
    client: publicClient, transport: http(PIMLICO_URL), paymaster: true,
    userOperation: { estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast },
  });

  console.log(`\nSending ${calls.length} calls via Pimlico...`);
  const opHash  = await bundlerClient.sendUserOperation({ account: smartAcct, calls });
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
  console.log(`\n✅ tx: ${receipt.receipt.transactionHash}`);
  console.log(`   https://arbiscan.io/tx/${receipt.receipt.transactionHash}`);

  const usdcEOA = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [eoaAddress] });
  console.log(`\n💰 USDC in EOA: ${formatUnits(usdcEOA, 6)}`);
}

main().catch(e => { console.error('[FATAL]', e?.message ?? e); process.exit(1); });
