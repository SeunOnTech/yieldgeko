import {
  createUseWriteContract,
  createUseSimulateContract,
  createUseReadContract,
  createUseWatchContractEvent,
} from 'wagmi/codegen'

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IStrategyAdapter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iStrategyAdapterAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'asset', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'deposit',
    outputs: [
      { name: 'depositedAmount', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'asset', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'recipient', internalType: 'address', type: 'address' },
    ],
    name: 'withdraw',
    outputs: [
      { name: 'withdrawnAmount', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// StrategyRegistry
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const strategyRegistryAbi = [
  { type: 'constructor', inputs: [], stateMutability: 'nonpayable' },
  {
    type: 'function',
    inputs: [
      { name: '_strategy', internalType: 'address', type: 'address' },
      { name: '_adapter', internalType: 'address', type: 'address' },
      { name: '_name', internalType: 'string', type: 'string' },
      { name: '_chainId', internalType: 'uint64', type: 'uint64' },
      { name: '_minLiquidity', internalType: 'uint256', type: 'uint256' },
      { name: '_isAudited', internalType: 'bool', type: 'bool' },
    ],
    name: 'addStrategy',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getActiveStrategies',
    outputs: [{ name: '', internalType: 'address[]', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_strategy', internalType: 'address', type: 'address' }],
    name: 'getStrategyInfo',
    outputs: [
      {
        name: '',
        internalType: 'struct StrategyRegistry.StrategyInfo',
        type: 'tuple',
        components: [
          { name: 'isActive', internalType: 'bool', type: 'bool' },
          { name: 'adapter', internalType: 'address', type: 'address' },
          { name: 'name', internalType: 'string', type: 'string' },
          { name: 'chainId', internalType: 'uint64', type: 'uint64' },
          { name: 'minLiquidity', internalType: 'uint256', type: 'uint256' },
          { name: 'isAudited', internalType: 'bool', type: 'bool' },
          { name: 'isPaused', internalType: 'bool', type: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_strategy', internalType: 'address', type: 'address' }],
    name: 'isStrategyApproved',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_strategy', internalType: 'address', type: 'address' },
      { name: '_pause', internalType: 'bool', type: 'bool' },
    ],
    name: 'pauseStrategy',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_strategy', internalType: 'address', type: 'address' }],
    name: 'removeStrategy',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'strategies',
    outputs: [
      { name: 'isActive', internalType: 'bool', type: 'bool' },
      { name: 'adapter', internalType: 'address', type: 'address' },
      { name: 'name', internalType: 'string', type: 'string' },
      { name: 'chainId', internalType: 'uint64', type: 'uint64' },
      { name: 'minLiquidity', internalType: 'uint256', type: 'uint256' },
      { name: 'isAudited', internalType: 'bool', type: 'bool' },
      { name: 'isPaused', internalType: 'bool', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'newOwner', internalType: 'address', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'previousOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'newOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'OwnershipTransferred',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'strategy',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'adapter',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'name', internalType: 'string', type: 'string', indexed: false },
      {
        name: 'chainId',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
    ],
    name: 'StrategyAdded',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'strategy',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'StrategyPaused',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'strategy',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'StrategyRemoved',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'strategy',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'StrategyUnpaused',
  },
  {
    type: 'error',
    inputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    name: 'OwnableInvalidOwner',
  },
  {
    type: 'error',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'OwnableUnauthorizedAccount',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// YieldGekoRouter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const yieldGekoRouterAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_registry', internalType: 'address', type: 'address' },
      { name: '_agent', internalType: 'address', type: 'address' },
      { name: '_treasury', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'INTENT_TYPEHASH',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MIGRATION_FEE_BPS',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'SUCCESS_FEE_BPS',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'authorizedAgent',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_asset', internalType: 'address', type: 'address' },
      { name: '_amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'domainSeparator',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'eip712Domain',
    outputs: [
      { name: 'fields', internalType: 'bytes1', type: 'bytes1' },
      { name: 'name', internalType: 'string', type: 'string' },
      { name: 'version', internalType: 'string', type: 'string' },
      { name: 'chainId', internalType: 'uint256', type: 'uint256' },
      { name: 'verifyingContract', internalType: 'address', type: 'address' },
      { name: 'salt', internalType: 'bytes32', type: 'bytes32' },
      { name: 'extensions', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '_params',
        internalType: 'struct YieldGekoRouter.BatchMigrationParams[]',
        type: 'tuple[]',
        components: [
          {
            name: 'intent',
            internalType: 'struct YieldGekoRouter.Intent',
            type: 'tuple',
            components: [
              { name: 'user', internalType: 'address', type: 'address' },
              { name: 'asset', internalType: 'address', type: 'address' },
              {
                name: 'fromStrategy',
                internalType: 'address',
                type: 'address',
              },
              { name: 'toStrategy', internalType: 'address', type: 'address' },
              { name: 'amount', internalType: 'uint256', type: 'uint256' },
              { name: 'minAPY', internalType: 'uint256', type: 'uint256' },
              { name: 'expectedAPY', internalType: 'uint256', type: 'uint256' },
              { name: 'maxSlippage', internalType: 'uint256', type: 'uint256' },
              { name: 'maxFee', internalType: 'uint256', type: 'uint256' },
              { name: 'nonce', internalType: 'uint256', type: 'uint256' },
              { name: 'deadline', internalType: 'uint256', type: 'uint256' },
            ],
          },
          { name: 'signature', internalType: 'bytes', type: 'bytes' },
          {
            name: 'actualSlippageBps',
            internalType: 'uint256',
            type: 'uint256',
          },
          { name: 'receiptHash', internalType: 'bytes32', type: 'bytes32' },
          { name: 'gasFeeInAsset', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    name: 'executeBatchMigration',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '_intent',
        internalType: 'struct YieldGekoRouter.Intent',
        type: 'tuple',
        components: [
          { name: 'user', internalType: 'address', type: 'address' },
          { name: 'asset', internalType: 'address', type: 'address' },
          { name: 'fromStrategy', internalType: 'address', type: 'address' },
          { name: 'toStrategy', internalType: 'address', type: 'address' },
          { name: 'amount', internalType: 'uint256', type: 'uint256' },
          { name: 'minAPY', internalType: 'uint256', type: 'uint256' },
          { name: 'expectedAPY', internalType: 'uint256', type: 'uint256' },
          { name: 'maxSlippage', internalType: 'uint256', type: 'uint256' },
          { name: 'maxFee', internalType: 'uint256', type: 'uint256' },
          { name: 'nonce', internalType: 'uint256', type: 'uint256' },
          { name: 'deadline', internalType: 'uint256', type: 'uint256' },
        ],
      },
      { name: '_signature', internalType: 'bytes', type: 'bytes' },
      { name: '_actualSlippageBps', internalType: 'uint256', type: 'uint256' },
      { name: '_receiptHash', internalType: 'bytes32', type: 'bytes32' },
      { name: '_gasFeeInAsset', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'executeMigration',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '_intent',
        internalType: 'struct YieldGekoRouter.Intent',
        type: 'tuple',
        components: [
          { name: 'user', internalType: 'address', type: 'address' },
          { name: 'asset', internalType: 'address', type: 'address' },
          { name: 'fromStrategy', internalType: 'address', type: 'address' },
          { name: 'toStrategy', internalType: 'address', type: 'address' },
          { name: 'amount', internalType: 'uint256', type: 'uint256' },
          { name: 'minAPY', internalType: 'uint256', type: 'uint256' },
          { name: 'expectedAPY', internalType: 'uint256', type: 'uint256' },
          { name: 'maxSlippage', internalType: 'uint256', type: 'uint256' },
          { name: 'maxFee', internalType: 'uint256', type: 'uint256' },
          { name: 'nonce', internalType: 'uint256', type: 'uint256' },
          { name: 'deadline', internalType: 'uint256', type: 'uint256' },
        ],
      },
      { name: '_signature', internalType: 'bytes', type: 'bytes' },
      { name: '_actualSlippageBps', internalType: 'uint256', type: 'uint256' },
      { name: '_receiptHash', internalType: 'bytes32', type: 'bytes32' },
      { name: '_gasFeeInAsset', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'executeMigrationExternal',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'nonces',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'pause',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'paused',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'registry',
    outputs: [
      { name: '', internalType: 'contract StrategyRegistry', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_agent', internalType: 'address', type: 'address' }],
    name: 'setAuthorizedAgent',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_treasury', internalType: 'address', type: 'address' }],
    name: 'setTreasury',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'address', type: 'address' },
      { name: '', internalType: 'address', type: 'address' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    name: 'strategyPositions',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'newOwner', internalType: 'address', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'treasury',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'unpause',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'address', type: 'address' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    name: 'userBalances',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_asset', internalType: 'address', type: 'address' },
      { name: '_amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'newAgent',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'AgentUpdated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'asset',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Deposited',
  },
  { type: 'event', anonymous: false, inputs: [], name: 'EIP712DomainChanged' },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'migrationFee',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'successFee',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'gasFee',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'receiptHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'FeeSettled',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'fromStrategy',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'toStrategy',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'totalFee',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'MigrationExecuted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'reason',
        internalType: 'string',
        type: 'string',
        indexed: false,
      },
    ],
    name: 'MigrationFailed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'previousOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'newOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'OwnershipTransferred',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'account',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'Paused',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'asset',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'strategy',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'positionAmount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'StrategyPositionUpdated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'newTreasury',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'TreasuryUpdated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'account',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'Unpaused',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'asset',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Withdrawn',
  },
  { type: 'error', inputs: [], name: 'ECDSAInvalidSignature' },
  {
    type: 'error',
    inputs: [{ name: 'length', internalType: 'uint256', type: 'uint256' }],
    name: 'ECDSAInvalidSignatureLength',
  },
  {
    type: 'error',
    inputs: [{ name: 's', internalType: 'bytes32', type: 'bytes32' }],
    name: 'ECDSAInvalidSignatureS',
  },
  { type: 'error', inputs: [], name: 'EnforcedPause' },
  { type: 'error', inputs: [], name: 'ExpectedPause' },
  { type: 'error', inputs: [], name: 'InvalidShortString' },
  {
    type: 'error',
    inputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    name: 'OwnableInvalidOwner',
  },
  {
    type: 'error',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'OwnableUnauthorizedAccount',
  },
  { type: 'error', inputs: [], name: 'ReentrancyGuardReentrantCall' },
  {
    type: 'error',
    inputs: [{ name: 'token', internalType: 'address', type: 'address' }],
    name: 'SafeERC20FailedOperation',
  },
  {
    type: 'error',
    inputs: [{ name: 'str', internalType: 'string', type: 'string' }],
    name: 'StringTooLong',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// React
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link iStrategyAdapterAbi}__
 */
export const useWriteIStrategyAdapter = /*#__PURE__*/ createUseWriteContract({
  abi: iStrategyAdapterAbi,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link iStrategyAdapterAbi}__ and `functionName` set to `"deposit"`
 */
export const useWriteIStrategyAdapterDeposit =
  /*#__PURE__*/ createUseWriteContract({
    abi: iStrategyAdapterAbi,
    functionName: 'deposit',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link iStrategyAdapterAbi}__ and `functionName` set to `"withdraw"`
 */
export const useWriteIStrategyAdapterWithdraw =
  /*#__PURE__*/ createUseWriteContract({
    abi: iStrategyAdapterAbi,
    functionName: 'withdraw',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link iStrategyAdapterAbi}__
 */
export const useSimulateIStrategyAdapter =
  /*#__PURE__*/ createUseSimulateContract({ abi: iStrategyAdapterAbi })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link iStrategyAdapterAbi}__ and `functionName` set to `"deposit"`
 */
export const useSimulateIStrategyAdapterDeposit =
  /*#__PURE__*/ createUseSimulateContract({
    abi: iStrategyAdapterAbi,
    functionName: 'deposit',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link iStrategyAdapterAbi}__ and `functionName` set to `"withdraw"`
 */
export const useSimulateIStrategyAdapterWithdraw =
  /*#__PURE__*/ createUseSimulateContract({
    abi: iStrategyAdapterAbi,
    functionName: 'withdraw',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link strategyRegistryAbi}__
 */
export const useReadStrategyRegistry = /*#__PURE__*/ createUseReadContract({
  abi: strategyRegistryAbi,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"getActiveStrategies"`
 */
export const useReadStrategyRegistryGetActiveStrategies =
  /*#__PURE__*/ createUseReadContract({
    abi: strategyRegistryAbi,
    functionName: 'getActiveStrategies',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"getStrategyInfo"`
 */
export const useReadStrategyRegistryGetStrategyInfo =
  /*#__PURE__*/ createUseReadContract({
    abi: strategyRegistryAbi,
    functionName: 'getStrategyInfo',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"isStrategyApproved"`
 */
export const useReadStrategyRegistryIsStrategyApproved =
  /*#__PURE__*/ createUseReadContract({
    abi: strategyRegistryAbi,
    functionName: 'isStrategyApproved',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"owner"`
 */
export const useReadStrategyRegistryOwner = /*#__PURE__*/ createUseReadContract(
  { abi: strategyRegistryAbi, functionName: 'owner' },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"strategies"`
 */
export const useReadStrategyRegistryStrategies =
  /*#__PURE__*/ createUseReadContract({
    abi: strategyRegistryAbi,
    functionName: 'strategies',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link strategyRegistryAbi}__
 */
export const useWriteStrategyRegistry = /*#__PURE__*/ createUseWriteContract({
  abi: strategyRegistryAbi,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"addStrategy"`
 */
export const useWriteStrategyRegistryAddStrategy =
  /*#__PURE__*/ createUseWriteContract({
    abi: strategyRegistryAbi,
    functionName: 'addStrategy',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"pauseStrategy"`
 */
export const useWriteStrategyRegistryPauseStrategy =
  /*#__PURE__*/ createUseWriteContract({
    abi: strategyRegistryAbi,
    functionName: 'pauseStrategy',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"removeStrategy"`
 */
export const useWriteStrategyRegistryRemoveStrategy =
  /*#__PURE__*/ createUseWriteContract({
    abi: strategyRegistryAbi,
    functionName: 'removeStrategy',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"renounceOwnership"`
 */
export const useWriteStrategyRegistryRenounceOwnership =
  /*#__PURE__*/ createUseWriteContract({
    abi: strategyRegistryAbi,
    functionName: 'renounceOwnership',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"transferOwnership"`
 */
export const useWriteStrategyRegistryTransferOwnership =
  /*#__PURE__*/ createUseWriteContract({
    abi: strategyRegistryAbi,
    functionName: 'transferOwnership',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link strategyRegistryAbi}__
 */
export const useSimulateStrategyRegistry =
  /*#__PURE__*/ createUseSimulateContract({ abi: strategyRegistryAbi })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"addStrategy"`
 */
export const useSimulateStrategyRegistryAddStrategy =
  /*#__PURE__*/ createUseSimulateContract({
    abi: strategyRegistryAbi,
    functionName: 'addStrategy',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"pauseStrategy"`
 */
export const useSimulateStrategyRegistryPauseStrategy =
  /*#__PURE__*/ createUseSimulateContract({
    abi: strategyRegistryAbi,
    functionName: 'pauseStrategy',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"removeStrategy"`
 */
export const useSimulateStrategyRegistryRemoveStrategy =
  /*#__PURE__*/ createUseSimulateContract({
    abi: strategyRegistryAbi,
    functionName: 'removeStrategy',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"renounceOwnership"`
 */
export const useSimulateStrategyRegistryRenounceOwnership =
  /*#__PURE__*/ createUseSimulateContract({
    abi: strategyRegistryAbi,
    functionName: 'renounceOwnership',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link strategyRegistryAbi}__ and `functionName` set to `"transferOwnership"`
 */
export const useSimulateStrategyRegistryTransferOwnership =
  /*#__PURE__*/ createUseSimulateContract({
    abi: strategyRegistryAbi,
    functionName: 'transferOwnership',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link strategyRegistryAbi}__
 */
export const useWatchStrategyRegistryEvent =
  /*#__PURE__*/ createUseWatchContractEvent({ abi: strategyRegistryAbi })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link strategyRegistryAbi}__ and `eventName` set to `"OwnershipTransferred"`
 */
export const useWatchStrategyRegistryOwnershipTransferredEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: strategyRegistryAbi,
    eventName: 'OwnershipTransferred',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link strategyRegistryAbi}__ and `eventName` set to `"StrategyAdded"`
 */
export const useWatchStrategyRegistryStrategyAddedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: strategyRegistryAbi,
    eventName: 'StrategyAdded',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link strategyRegistryAbi}__ and `eventName` set to `"StrategyPaused"`
 */
export const useWatchStrategyRegistryStrategyPausedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: strategyRegistryAbi,
    eventName: 'StrategyPaused',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link strategyRegistryAbi}__ and `eventName` set to `"StrategyRemoved"`
 */
export const useWatchStrategyRegistryStrategyRemovedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: strategyRegistryAbi,
    eventName: 'StrategyRemoved',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link strategyRegistryAbi}__ and `eventName` set to `"StrategyUnpaused"`
 */
export const useWatchStrategyRegistryStrategyUnpausedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: strategyRegistryAbi,
    eventName: 'StrategyUnpaused',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__
 */
export const useReadYieldGekoRouter = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoRouterAbi,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"INTENT_TYPEHASH"`
 */
export const useReadYieldGekoRouterIntentTypehash =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoRouterAbi,
    functionName: 'INTENT_TYPEHASH',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"MIGRATION_FEE_BPS"`
 */
export const useReadYieldGekoRouterMigrationFeeBps =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoRouterAbi,
    functionName: 'MIGRATION_FEE_BPS',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"SUCCESS_FEE_BPS"`
 */
export const useReadYieldGekoRouterSuccessFeeBps =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoRouterAbi,
    functionName: 'SUCCESS_FEE_BPS',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"authorizedAgent"`
 */
export const useReadYieldGekoRouterAuthorizedAgent =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoRouterAbi,
    functionName: 'authorizedAgent',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"domainSeparator"`
 */
export const useReadYieldGekoRouterDomainSeparator =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoRouterAbi,
    functionName: 'domainSeparator',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"eip712Domain"`
 */
export const useReadYieldGekoRouterEip712Domain =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoRouterAbi,
    functionName: 'eip712Domain',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"nonces"`
 */
export const useReadYieldGekoRouterNonces = /*#__PURE__*/ createUseReadContract(
  { abi: yieldGekoRouterAbi, functionName: 'nonces' },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"owner"`
 */
export const useReadYieldGekoRouterOwner = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoRouterAbi,
  functionName: 'owner',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"paused"`
 */
export const useReadYieldGekoRouterPaused = /*#__PURE__*/ createUseReadContract(
  { abi: yieldGekoRouterAbi, functionName: 'paused' },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"registry"`
 */
export const useReadYieldGekoRouterRegistry =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoRouterAbi,
    functionName: 'registry',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"strategyPositions"`
 */
export const useReadYieldGekoRouterStrategyPositions =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoRouterAbi,
    functionName: 'strategyPositions',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"treasury"`
 */
export const useReadYieldGekoRouterTreasury =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoRouterAbi,
    functionName: 'treasury',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"userBalances"`
 */
export const useReadYieldGekoRouterUserBalances =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoRouterAbi,
    functionName: 'userBalances',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__
 */
export const useWriteYieldGekoRouter = /*#__PURE__*/ createUseWriteContract({
  abi: yieldGekoRouterAbi,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"deposit"`
 */
export const useWriteYieldGekoRouterDeposit =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'deposit',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"executeBatchMigration"`
 */
export const useWriteYieldGekoRouterExecuteBatchMigration =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'executeBatchMigration',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"executeMigration"`
 */
export const useWriteYieldGekoRouterExecuteMigration =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'executeMigration',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"executeMigrationExternal"`
 */
export const useWriteYieldGekoRouterExecuteMigrationExternal =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'executeMigrationExternal',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"pause"`
 */
export const useWriteYieldGekoRouterPause =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'pause',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"renounceOwnership"`
 */
export const useWriteYieldGekoRouterRenounceOwnership =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'renounceOwnership',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"setAuthorizedAgent"`
 */
export const useWriteYieldGekoRouterSetAuthorizedAgent =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'setAuthorizedAgent',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"setTreasury"`
 */
export const useWriteYieldGekoRouterSetTreasury =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'setTreasury',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"transferOwnership"`
 */
export const useWriteYieldGekoRouterTransferOwnership =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'transferOwnership',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"unpause"`
 */
export const useWriteYieldGekoRouterUnpause =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'unpause',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"withdraw"`
 */
export const useWriteYieldGekoRouterWithdraw =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoRouterAbi,
    functionName: 'withdraw',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__
 */
export const useSimulateYieldGekoRouter =
  /*#__PURE__*/ createUseSimulateContract({ abi: yieldGekoRouterAbi })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"deposit"`
 */
export const useSimulateYieldGekoRouterDeposit =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'deposit',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"executeBatchMigration"`
 */
export const useSimulateYieldGekoRouterExecuteBatchMigration =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'executeBatchMigration',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"executeMigration"`
 */
export const useSimulateYieldGekoRouterExecuteMigration =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'executeMigration',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"executeMigrationExternal"`
 */
export const useSimulateYieldGekoRouterExecuteMigrationExternal =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'executeMigrationExternal',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"pause"`
 */
export const useSimulateYieldGekoRouterPause =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'pause',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"renounceOwnership"`
 */
export const useSimulateYieldGekoRouterRenounceOwnership =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'renounceOwnership',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"setAuthorizedAgent"`
 */
export const useSimulateYieldGekoRouterSetAuthorizedAgent =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'setAuthorizedAgent',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"setTreasury"`
 */
export const useSimulateYieldGekoRouterSetTreasury =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'setTreasury',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"transferOwnership"`
 */
export const useSimulateYieldGekoRouterTransferOwnership =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'transferOwnership',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"unpause"`
 */
export const useSimulateYieldGekoRouterUnpause =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'unpause',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `functionName` set to `"withdraw"`
 */
export const useSimulateYieldGekoRouterWithdraw =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoRouterAbi,
    functionName: 'withdraw',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__
 */
export const useWatchYieldGekoRouterEvent =
  /*#__PURE__*/ createUseWatchContractEvent({ abi: yieldGekoRouterAbi })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"AgentUpdated"`
 */
export const useWatchYieldGekoRouterAgentUpdatedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'AgentUpdated',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"Deposited"`
 */
export const useWatchYieldGekoRouterDepositedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'Deposited',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"EIP712DomainChanged"`
 */
export const useWatchYieldGekoRouterEip712DomainChangedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'EIP712DomainChanged',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"FeeSettled"`
 */
export const useWatchYieldGekoRouterFeeSettledEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'FeeSettled',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"MigrationExecuted"`
 */
export const useWatchYieldGekoRouterMigrationExecutedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'MigrationExecuted',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"MigrationFailed"`
 */
export const useWatchYieldGekoRouterMigrationFailedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'MigrationFailed',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"OwnershipTransferred"`
 */
export const useWatchYieldGekoRouterOwnershipTransferredEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'OwnershipTransferred',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"Paused"`
 */
export const useWatchYieldGekoRouterPausedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'Paused',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"StrategyPositionUpdated"`
 */
export const useWatchYieldGekoRouterStrategyPositionUpdatedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'StrategyPositionUpdated',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"TreasuryUpdated"`
 */
export const useWatchYieldGekoRouterTreasuryUpdatedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'TreasuryUpdated',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"Unpaused"`
 */
export const useWatchYieldGekoRouterUnpausedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'Unpaused',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoRouterAbi}__ and `eventName` set to `"Withdrawn"`
 */
export const useWatchYieldGekoRouterWithdrawnEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoRouterAbi,
    eventName: 'Withdrawn',
  })
