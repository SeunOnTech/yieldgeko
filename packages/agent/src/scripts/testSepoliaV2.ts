

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  encodePacked,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { createBundlerClient } from 'viem/account-abstraction'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import {
  Implementation,
  toMetaMaskSmartAccount,
  getSmartAccountsEnvironment,
  createExecution,
  ExecutionMode,
  createCaveat,
  ROOT_AUTHORITY,
  contracts,
  type MetaMaskSmartAccount,
} from '@metamask/smart-accounts-kit'

const SEPOLIA_RPC     = 'https://ethereum-sepolia-rpc.publicnode.com'
const PIMLICO_URL     = `https://api.pimlico.io/v2/11155111/rpc?apikey=${process.env.PIMLICO_API_KEY ?? 'pim_V6Nq5uLXqFuXPXxTV1nxY5'}`

const ENFORCER  = '0xe2D93183f0BC699e42f80b198542cfdf83B3CD2d' as Address
const EXECUTOR  = '0xA689ed7b137B2268504Bc3eC6F2aCd37eC3a3CeB' as Address
const SWAPPER   = '0xdBd12F1f1E2AF8a3dE0927b906127AeE15F4964e' as Address

const MOCK_USDC     = '0xeD2D87acE3Adc4F4a50e34c6B3cf2DBAbDe6A5C4' as Address
const MOCK_PROTOCOL = '0x922Ec8f283eAEfafDE2A492823E67e64E6e89f32' as Address

const DEPOSIT_AMOUNT = 1000n * 10n ** 6n 

const MOCK_USDC_ABI = parseAbi([
  'function mint(address to, uint256 amount) external',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
])

const MOCK_PROTOCOL_ABI = parseAbi([
  'function getDeposit(address user) external view returns (uint256)',
])

const ENFORCER_ABI = parseAbi([
  'function authorizedAgents(address) external view returns (bool)',
  'function setAuthorizedAgent(address agent, bool authorized) external',
  'function peakInitialized(bytes32) external view returns (bool)',
  'function peakValueUSD6(bytes32) external view returns (uint256)',
])

const EXECUTOR_ABI = parseAbi([
  'function setAuthorizedCaller(address caller, bool authorized) external',
  'function authorizedCallers(address) external view returns (bool)',
])

async function main() {
  const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex
  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY env var required')

  const ownerAccount = privateKeyToAccount(PRIVATE_KEY)
  const environment  = getSmartAccountsEnvironment(sepolia.id)

  
  const SIMPLE_FACTORY           = environment.SimpleFactory as Address
  const ALLOWED_TARGETS_ENFORCER = environment.caveatEnforcers.AllowedTargetsEnforcer as Address

  const publicClient  = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) })
  const walletClient  = createWalletClient({ account: ownerAccount, chain: sepolia, transport: http(SEPOLIA_RPC) })
  
  const bundlerClient = createBundlerClient({
    client:     publicClient,
    transport:  http(PIMLICO_URL),
    paymaster:  true, 
  })

  console.log('==============================================')
  console.log('YieldGeko V2 - Sepolia E2E Delegation Test')
  console.log('==============================================')
  console.log(`EOA (owner + agent): ${ownerAccount.address}`)
  console.log(`DelegationManager:   ${environment.DelegationManager}`)

  

  console.log('\n[1/7] Creating MetaMask HybridDeleGator smart account...')

  const delegatorSmartAccount: MetaMaskSmartAccount<Implementation.Hybrid> =
    await toMetaMaskSmartAccount({
      client:         publicClient,
      implementation: Implementation.Hybrid,
      deployParams:   [ownerAccount.address, [], [], []] as const,
      deploySalt:     '0x',
      signer:         { account: ownerAccount },
    })

  const smartAccountAddress = delegatorSmartAccount.address
  const code = await publicClient.getBytecode({ address: smartAccountAddress })
  const isDeployed = !!code && code !== '0x'

  console.log(`  Smart account: ${smartAccountAddress}`)
  console.log(`  Deployed:      ${isDeployed}`)

  

  console.log('\n[2/7] Funding smart account + wiring contracts...')

  const existingBalance = await publicClient.readContract({
    address: MOCK_USDC, abi: MOCK_USDC_ABI, functionName: 'balanceOf', args: [smartAccountAddress],
  })

  if (existingBalance < DEPOSIT_AMOUNT) {
    const tx = await walletClient.writeContract({
      address: MOCK_USDC, abi: MOCK_USDC_ABI,
      functionName: 'mint', args: [smartAccountAddress, DEPOSIT_AMOUNT * 2n],
    })
    await publicClient.waitForTransactionReceipt({ hash: tx })
    console.log(`  [OK] Minted 2,000 mUSDC to smart account`)
  } else {
    console.log(`  [OK] Balance already: ${Number(existingBalance)/1e6} mUSDC`)
  }

  const isCallerAuth = await publicClient.readContract({
    address: EXECUTOR, abi: EXECUTOR_ABI, functionName: 'authorizedCallers', args: [smartAccountAddress],
  })
  if (!isCallerAuth) {
    const tx = await walletClient.writeContract({
      address: EXECUTOR, abi: EXECUTOR_ABI,
      functionName: 'setAuthorizedCaller', args: [smartAccountAddress, true],
    })
    await publicClient.waitForTransactionReceipt({ hash: tx })
    console.log(`  [OK] Smart account authorized in executor`)
  } else {
    console.log(`  [OK] Smart account already authorized in executor`)
  }

  const isAgentAuth = await publicClient.readContract({
    address: ENFORCER, abi: ENFORCER_ABI, functionName: 'authorizedAgents', args: [ownerAccount.address],
  })
  if (!isAgentAuth) {
    const tx = await walletClient.writeContract({
      address: ENFORCER, abi: ENFORCER_ABI,
      functionName: 'setAuthorizedAgent', args: [ownerAccount.address, true],
    })
    await publicClient.waitForTransactionReceipt({ hash: tx })
    console.log(`  [OK] EOA authorized as agent in enforcer`)
  } else {
    console.log(`  [OK] EOA already authorized in enforcer`)
  }

  

  console.log('\n[3/6] Deploying smart account via SimpleFactory...')

  if (!isDeployed) {
    
    const hybridImpl = environment.implementations.HybridDeleGatorImpl as Address
    const initcode = encodeFunctionData({
      abi: parseAbi(['function initialize(address,string[],uint256[],uint256[]) external']),
      functionName: 'initialize',
      args: [ownerAccount.address, [], [], []],
    })
    const proxyCrtCode = contracts.encodeProxyCreationCode({
      implementationAddress: hybridImpl,
      initcode,
    })

    const SIMPLE_FACTORY_ABI = parseAbi([
      'function deploy(bytes calldata bytecode, bytes32 salt) external returns (address)',
    ])

    const deployTx = await walletClient.writeContract({
      address: SIMPLE_FACTORY,
      abi: SIMPLE_FACTORY_ABI,
      functionName: 'deploy',
      args: [proxyCrtCode, '0x0000000000000000000000000000000000000000000000000000000000000000'],
    })
    await publicClient.waitForTransactionReceipt({ hash: deployTx })
    console.log(`  [OK] Smart account deployed — tx: ${deployTx}`)
  } else {
    console.log(`  [OK] Already deployed`)
  }

  

  console.log('\n[4/6] Approving executor to spend USDC from smart account...')

  const currentAllowance = await publicClient.readContract({
    address: MOCK_USDC, abi: MOCK_USDC_ABI,
    functionName: 'allowance', args: [smartAccountAddress, EXECUTOR],
  })

  
  const executorBalance = await publicClient.readContract({
    address: MOCK_USDC, abi: MOCK_USDC_ABI, functionName: 'balanceOf', args: [EXECUTOR],
  })
  const needsTransfer = executorBalance < DEPOSIT_AMOUNT

  if (currentAllowance < DEPOSIT_AMOUNT || needsTransfer) {
    
    const calls: { to: Address; value: bigint; data: Hex }[] = []

    if (currentAllowance < DEPOSIT_AMOUNT) {
      calls.push({
        to: MOCK_USDC, value: 0n,
        data: encodeFunctionData({ abi: MOCK_USDC_ABI, functionName: 'approve', args: [EXECUTOR, DEPOSIT_AMOUNT * 10n] }),
      })
    }
    if (needsTransfer) {
      calls.push({
        to: MOCK_USDC, value: 0n,
        data: encodeFunctionData({ abi: MOCK_USDC_ABI, functionName: 'transfer', args: [EXECUTOR, DEPOSIT_AMOUNT] }),
      })
    }

    const opHash = await bundlerClient.sendUserOperation({ account: delegatorSmartAccount, calls })
    const opReceipt = await bundlerClient.waitForUserOperationReceipt({ hash: opHash })
    console.log(`  [OK] Setup UserOp complete — tx: ${opReceipt.receipt.transactionHash}`)
  } else {
    console.log(`  [OK] Already set up (allowance: ${Number(currentAllowance)/1e6}, executor USDC: ${Number(executorBalance)/1e6})`)
  }

  
  const executorApproveABI = parseAbi(['function approveToken(address token, address protocol, uint256 amount) external'])
  const approveTx = await walletClient.writeContract({
    address: EXECUTOR, abi: executorApproveABI,
    functionName: 'approveToken',
    args: [MOCK_USDC, MOCK_PROTOCOL, DEPOSIT_AMOUNT],
  })
  await publicClient.waitForTransactionReceipt({ hash: approveTx })
  console.log(`  [OK] Executor approved MockProtocol for USDC`)

  

  console.log('\n[5/7] Building and signing ERC-7710 delegation...')

  
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600)
  const policyTerms = encodeAbiParameters(
    parseAbiParameters('uint256,uint256,uint256,uint256,address,uint256,address'),
    [500n, 1500n, 5000n * 10n**6n, 1500n, ownerAccount.address, expiresAt, MOCK_USDC]
  ) as Hex

  
  const allowedTargetsTerms = encodePacked(['address', 'address'], [EXECUTOR, SWAPPER]) as Hex

  
  const executionArgs = encodeAbiParameters(
    parseAbiParameters('uint256,uint256,uint256'),
    [DEPOSIT_AMOUNT, DEPOSIT_AMOUNT, 0n]
  ) as Hex

  
  const delegation = {
    delegate:  ownerAccount.address,      
    delegator: smartAccountAddress,       
    authority: ROOT_AUTHORITY,
    caveats: [
      createCaveat(ALLOWED_TARGETS_ENFORCER, allowedTargetsTerms, '0x'),
      createCaveat(ENFORCER, policyTerms, executionArgs),
    ],
    salt: '0x' as Hex,
  }

  
  
  const signature = await delegatorSmartAccount.signDelegation({ delegation })
  const signedDelegation = { ...delegation, signature }

  console.log(`  [OK] Delegation signed via delegatorSmartAccount.signDelegation()`)
  console.log(`       delegate:  ${ownerAccount.address}`)
  console.log(`       delegator: ${smartAccountAddress}`)

  

  console.log('\n[6/7] Redeeming delegation as agent (direct EOA tx)...')

  
  const supplyCalldata = encodeFunctionData({
    abi: parseAbi(['function supply(address,uint256,address,uint16) external']),
    functionName: 'supply',
    args: [MOCK_USDC, DEPOSIT_AMOUNT, smartAccountAddress, 0],
  })
  const executorCalldata = encodeFunctionData({
    abi: parseAbi(['function execute(address,bytes,uint256) external payable returns (bytes memory)']),
    functionName: 'execute',
    args: [MOCK_PROTOCOL, supplyCalldata, 0n],
  })

  const executions = [createExecution({ target: EXECUTOR, callData: executorCalldata })]

  
  const redeemCalldata = contracts.DelegationManager.encode.redeemDelegations({
    delegations: [[signedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [executions],
  })

  const depositBefore = await publicClient.readContract({
    address: MOCK_PROTOCOL, abi: MOCK_PROTOCOL_ABI, functionName: 'getDeposit', args: [smartAccountAddress],
  })
  const executorUsdcBefore = await publicClient.readContract({
    address: MOCK_USDC, abi: MOCK_USDC_ABI, functionName: 'balanceOf', args: [EXECUTOR],
  })

  console.log(`  Executor USDC before: ${Number(executorUsdcBefore)/1e6}`)
  console.log(`  Deposit before:       ${Number(depositBefore)/1e6}`)

  
  const redeemTx = await walletClient.sendTransaction({
    to: environment.DelegationManager as Address,
    data: redeemCalldata,
  })

  console.log(`  tx: ${redeemTx}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash: redeemTx })
  console.log(`  Block: ${receipt.blockNumber} | Gas: ${receipt.gasUsed} | Status: ${receipt.status}`)

  if (receipt.status !== 'success') throw new Error('redeemDelegations reverted')

  

  console.log('\n[7/7] Verifying results...')

  const executorUsdcAfter = await publicClient.readContract({
    address: MOCK_USDC, abi: MOCK_USDC_ABI, functionName: 'balanceOf', args: [EXECUTOR],
  })
  const depositAfter = await publicClient.readContract({
    address: MOCK_PROTOCOL, abi: MOCK_PROTOCOL_ABI, functionName: 'getDeposit', args: [smartAccountAddress],
  })

  
  const delegationForHash = { ...delegation, signature }
  const DELEGATION_TYPEHASH_STR = 'Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)'

  console.log(`  Executor USDC after:  ${Number(executorUsdcAfter)/1e6}`)
  console.log(`  Deposit after:        ${Number(depositAfter)/1e6}`)
  console.log(`  USDC spent by executor: ${Number(executorUsdcBefore - executorUsdcAfter)/1e6}`)

  if (depositAfter - depositBefore !== DEPOSIT_AMOUNT) throw new Error(`Wrong deposit: expected 1000, got ${Number(depositAfter - depositBefore)/1e6}`)
  if (executorUsdcBefore - executorUsdcAfter !== DEPOSIT_AMOUNT) throw new Error(`Executor USDC not spent correctly`)

  console.log('\n==============================================')
  console.log('ALL CHECKS PASSED')
  console.log('==============================================')
  console.log('')
  console.log('Certified on Ethereum Sepolia:')
  console.log('  [OK] MetaMask HybridDeleGator smart account via toMetaMaskSmartAccount()')
  console.log('  [OK] Delegation signed via SDK signDelegation()')
  console.log('  [OK] contracts.DelegationManager.encode.redeemDelegations() used')
  console.log('  [OK] AllowedTargets enforcer validated executor call')
  console.log('  [OK] YieldGekoPolicyCaveatEnforcer beforeHook + afterHook fired')
  console.log('  [OK] YieldGekoExecutor routed call to MockYieldProtocol')
  console.log('  [OK] $1,000 mUSDC deposited via ERC-7710 delegation')
  console.log('')
  console.log('Sepolia Etherscan:')
  console.log(`  tx:         https://sepolia.etherscan.io/tx/${redeemTx}`)
  console.log(`  SmartAcct:  https://sepolia.etherscan.io/address/${smartAccountAddress}`)
  console.log(`  Enforcer:   https://sepolia.etherscan.io/address/${ENFORCER}`)
  console.log(`  Executor:   https://sepolia.etherscan.io/address/${EXECUTOR}`)
}

main().catch(err => {
  console.error('\n[FAILED]', err.message ?? err)
  process.exit(1)
})
