import 'dotenv/config';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { createPublicClient, http, parseAbi, formatUnits, type Address, type Hex } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { toMetaMaskSmartAccount, Implementation } from '@metamask/smart-accounts-kit';

const ARB_RPC     = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const PIMLICO_KEY = process.env.PIMLICO_API_KEY!;
const PIMLICO_URL = `https://api.pimlico.io/v2/42161/rpc?apikey=${PIMLICO_KEY}`;
const USDC_ADDR   = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;

async function main() {
  if (!process.env.TEST_USER_PRIVKEY) throw new Error('TEST_USER_PRIVKEY required');
  if (!PIMLICO_KEY) throw new Error('PIMLICO_API_KEY required');

  const userAccount = privateKeyToAccount(process.env.TEST_USER_PRIVKEY as Hex);
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(ARB_RPC) });

  console.log(`\nWithdrawal Target: ${userAccount.address}`);

  
  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [userAccount.address, [], [], []] as const,
    deploySalt: '0x',
    signer: { account: userAccount },
  });

  console.log(`Smart Account Address: ${smartAccount.address}`);

  
  const pimlicoClient = createPimlicoClient({
    transport: http(PIMLICO_URL),
    entryPoint: { address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address, version: '0.7' },
  });

  const bundlerClient = createBundlerClient({
    client: publicClient,
    transport: http(PIMLICO_URL),
    paymaster: true,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });

  
  const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address, uint256) returns (bool)']);
  const balance = await publicClient.readContract({
    address: USDC_ADDR,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [smartAccount.address],
  });

  if (balance === 0n) {
    console.log('❌ No USDC balance found in smart account.');
    return;
  }

  console.log(`Current Balance: ${formatUnits(balance, 6)} USDC`);
  console.log(`Sending ALL funds back to EOA sponsored by Pimlico...`);

  
  const opHash = await bundlerClient.sendUserOperation({
    account: smartAccount,
    calls: [
      {
        to: USDC_ADDR,
        value: 0n,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [userAccount.address, balance],
        }),
      },
    ],
  });

  console.log(`⏳ UserOperation sent: ${opHash}`);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
  console.log(`✅ Withdrawal Successful! Tx: ${receipt.receipt.transactionHash}`);
  console.log(`The gas was fully sponsored by Pimlico.`);
}

import { encodeFunctionData } from 'viem';
main().catch(console.error);
