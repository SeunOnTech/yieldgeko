/**
 * Send 1.1 USDC from TEST_USER_ADDRESS to RECIPIENT using EIP-2612 permit + Pimlico sponsorship.
 *
 * Flow:
 *   1. Sign an off-chain EIP-2612 permit: owner=TEST_USER, spender=agentSmartAccount, value=1.1 USDC
 *   2. Agent's Pimlico smart account submits a batch UserOp:
 *        a. USDC.permit(owner, agentSmartAccount, amount, deadline, v, r, s)
 *        b. USDC.transferFrom(owner, RECIPIENT, amount)
 *   3. Pimlico verifying paymaster sponsors the gas — no ETH needed from anyone
 *
 * The sender (TEST_USER_ADDRESS) only needs USDC — no ETH required.
 */

import * as dotenv  from 'dotenv'
import * as path    from 'node:path'
import { ethers }   from 'ethers'
import { initPimlicoLayer } from '../src/orchestrator/erc4337'

dotenv.config({ path: path.resolve(__dirname, '../.env') })
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), override: true })

// ── Config ────────────────────────────────────────────────────────────────────

const SENDER    = '0x092106703adE19BF7a638AD371f8f6c25831F349'
const RECIPIENT = '0x8706347464De19f804FdCEa4A8b8ED6A152C4F06'
const AMOUNT    = 1_100_000n   // 1.1 USDC (6 decimals)

const USDC_ADDRESS  = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const ARB_RPC       = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc'
const SENDER_KEY    = process.env.TEST_USER_PRIVKEY!
const AGENT_KEY     = process.env.AGENT_PRIVATE_KEY!
const PIMLICO_KEY   = process.env.PIMLICO_API_KEY!

// ── ABIs ──────────────────────────────────────────────────────────────────────

const USDC_ABI = [
  'function nonces(address owner) view returns (uint256)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner',    type: 'address' },
    { name: 'spender',  type: 'address' },
    { name: 'value',    type: 'uint256' },
    { name: 'nonce',    type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════╗')
  console.log('║  USDC Transfer via EIP-2612 Permit + Pimlico     ║')
  console.log('╚═══════════════════════════════════════════════════╝\n')

  if (!SENDER_KEY || !AGENT_KEY || !PIMLICO_KEY) {
    throw new Error('Missing env: TEST_USER_PRIVKEY, AGENT_PRIVATE_KEY, or PIMLICO_API_KEY')
  }

  const provider = new ethers.JsonRpcProvider(ARB_RPC)
  const usdc     = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider)
  const senderWallet = new ethers.Wallet(SENDER_KEY, provider)

  // ── 1. Pre-flight checks ──────────────────────────────────────────────────
  const senderBalance: bigint = await usdc.balanceOf(SENDER)
  console.log(`Sender  : ${SENDER}`)
  console.log(`Recipient: ${RECIPIENT}`)
  console.log(`Amount  : 1.1 USDC`)
  console.log(`Sender USDC balance: ${Number(senderBalance) / 1e6} USDC`)

  if (senderBalance < AMOUNT) {
    throw new Error(`Insufficient USDC: have ${Number(senderBalance) / 1e6}, need 1.1`)
  }

  // ── 2. Init Pimlico smart account (agent's account is the executor) ───────
  console.log('\nInitialising Pimlico smart account...')
  const pimlico = await initPimlicoLayer(AGENT_KEY, PIMLICO_KEY, ARB_RPC)
  const agentSmartAccount = pimlico.smartAccountAddress
  console.log(`Agent smart account: ${agentSmartAccount}`)

  // ── 3. Sign EIP-2612 permit (off-chain, no gas) ───────────────────────────
  console.log('\nSigning EIP-2612 permit...')

  const nonce:    bigint = await usdc.nonces(SENDER)
  const deadline: bigint = BigInt(Math.floor(Date.now() / 1000) + 3600)  // 1 hour

  const domain = {
    name:              'USD Coin',
    version:           '2',
    chainId:           42161,
    verifyingContract: USDC_ADDRESS as `0x${string}`,
  }

  const permitMessage = {
    owner:    SENDER,
    spender:  agentSmartAccount,
    value:    AMOUNT,
    nonce,
    deadline,
  }

  const sig = await senderWallet.signTypedData(domain, PERMIT_TYPES, permitMessage)
  const { v, r, s } = ethers.Signature.from(sig)
  console.log(`  Nonce   : ${nonce}`)
  console.log(`  Deadline: ${new Date(Number(deadline) * 1000).toISOString()}`)
  console.log(`  v=${v} r=${r.slice(0, 10)}… s=${s.slice(0, 10)}…`)

  // ── 4. Build permit + transferFrom calldata ───────────────────────────────
  const iface = new ethers.Interface(USDC_ABI)

  const permitCalldata = iface.encodeFunctionData('permit', [
    SENDER, agentSmartAccount, AMOUNT, deadline, v, r, s,
  ])

  const transferCalldata = iface.encodeFunctionData('transferFrom', [
    SENDER, RECIPIENT, AMOUNT,
  ])

  // ── 5. Submit atomic batch UserOp via Pimlico (sponsored) ─────────────────
  console.log('\nSubmitting sponsored UserOp batch (permit + transferFrom)...')

  const txHash = await pimlico.sendBatch([
    { to: USDC_ADDRESS, calldata: permitCalldata,   value: 0n },
    { to: USDC_ADDRESS, calldata: transferCalldata, value: 0n },
  ])

  console.log('\n✅  Transfer complete!')
  console.log(`   Tx hash : ${txHash}`)
  console.log(`   Explorer: https://arbiscan.io/tx/${txHash}`)

  // ── 6. Confirm balances ───────────────────────────────────────────────────
  await new Promise(r => setTimeout(r, 3000))  // brief wait for indexer
  const newSenderBal    = await usdc.balanceOf(SENDER)
  const recipientBal    = await usdc.balanceOf(RECIPIENT)
  console.log(`\n   Sender balance now   : ${Number(newSenderBal) / 1e6} USDC`)
  console.log(`   Recipient balance now: ${Number(recipientBal) / 1e6} USDC`)
}

main().catch(err => {
  console.error('\n❌  Error:', err.message)
  process.exit(1)
})
