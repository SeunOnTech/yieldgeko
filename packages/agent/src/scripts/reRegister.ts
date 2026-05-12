import 'dotenv/config';
import { createPublicClient, http, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import {
  toMetaMaskSmartAccount,
  Implementation,
  ROOT_AUTHORITY,
  createCaveat,
} from '@metamask/smart-accounts-kit';
import { encodeAbiParameters, parseAbiParameters } from 'viem';

const AGENT_BASE = process.env.AGENT_BASE_URL ?? 'http://localhost:3001';
const ARB_RPC    = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';

const TREASURY = '0x092106703adE19BF7a638AD371f8f6c25831F349'; // Default treasury
const ENFORCER = '0x21b25E099CA7AF1BEa3a4558E437C56680B4b925';
const USDC     = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

async function main() {
  if (!process.env.TEST_USER_PRIVKEY) throw new Error('TEST_USER_PRIVKEY required');
  const userAccount = privateKeyToAccount(process.env.TEST_USER_PRIVKEY as Hex);
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(ARB_RPC) });

  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [userAccount.address, [], [], []] as const,
    deploySalt: '0x',
    signer: { account: userAccount },
  });

  console.log(`Smart Account: ${smartAccount.address}`);

  const expiresAt   = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
  const managedUSD6 = 1000000n; // $1

  const policyTerms = encodeAbiParameters(
    parseAbiParameters('uint256, uint256, uint256, uint256, address, uint256, address'),
    [
      200n,         // minAPYBps
      2000n,        // maxDrawdownBps
      managedUSD6,  // managedUSD6
      1000n,        // maxFeeBps
      TREASURY as Address,
      expiresAt,
      USDC as Address,
    ],
  ) as Hex;

  const delegation = {
    delegate:  '0x0aC0299A57D8035983EbdC4172F3F1D0698f3d4B' as Address,
    delegator: smartAccount.address,
    authority: ROOT_AUTHORITY,
    caveats: [
      createCaveat(ENFORCER as Address, policyTerms, '0x'),
    ],
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
  };

  const signature = await smartAccount.signDelegation({ delegation });
  const signedDelegation = { ...delegation, signature };

  const payload = {
    displayName: `Apex Alpha`,
    riskTier: 'aggressive',
    managedUSD: 1,
    minAPY: 2,
    maxSlippageBps: 50,
    maxDrawdownPct: 20,
    maxFeeBps: 1000,
    migrationThresholdPct: 10,
    userAddress: userAccount.address,
    smartAccountAddress: smartAccount.address,
    signedDelegation: signedDelegation,
  };

  const agentKey = process.env.AGENT_API_KEY || '8a86bc5b721ef5e5fa6a336af1e8fa617496e43ad8885adbb6cb86a1d38b6c81';

  const res = await fetch(`${AGENT_BASE}/api/register`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${agentKey}`
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  console.log('Registration Result:', json);
  console.log('\nSuccess! Now check your dashboard.');
}

main().catch(console.error);
