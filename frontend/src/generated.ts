import {
  createUseReadContract,
  createUseWriteContract,
  createUseSimulateContract,
  createUseWatchContractEvent,
} from 'wagmi/codegen'

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// YieldGeko
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const yieldGekoAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_agent', internalType: 'address', type: 'address' },
      { name: '_treasury', internalType: 'address', type: 'address' },
      { name: '_defaultFeeBps', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  { type: 'receive', stateMutability: 'payable' },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_DRAWDOWN_BPS',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_FEE_BPS',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_POLICY_DURATION',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'POLICY_TYPEHASH',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'acceptOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'chainId', internalType: 'uint256', type: 'uint256' },
      { name: 'target', internalType: 'address', type: 'address' },
    ],
    name: 'approveTarget',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'asset', internalType: 'address', type: 'address' },
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'approveToken',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    name: 'approvedTargets',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
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
      { name: '', internalType: 'address', type: 'address' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    name: 'balances',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'asset', internalType: 'address', type: 'address' },
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'grossAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'collectFee',
    outputs: [{ name: 'netAmount', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'defaultFeeBps',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'address', type: 'address' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    name: 'deployed',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'asset', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
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
    inputs: [],
    name: 'emergencyMode',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'asset', internalType: 'address', type: 'address' }],
    name: 'emergencyWithdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'data', internalType: 'bytes', type: 'bytes' },
      { name: 'receiptHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'guardAsset', internalType: 'address', type: 'address' },
    ],
    name: 'execute',
    outputs: [{ name: '', internalType: 'bytes', type: 'bytes' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'asset', internalType: 'address', type: 'address' },
      { name: 'targets', internalType: 'address[]', type: 'address[]' },
      { name: 'dataArr', internalType: 'bytes[]', type: 'bytes[]' },
      { name: 'receiptHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'executeBatch',
    outputs: [{ name: 'results', internalType: 'bytes[]', type: 'bytes[]' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'assets', internalType: 'address[]', type: 'address[]' },
      { name: 'targets', internalType: 'address[]', type: 'address[]' },
      { name: 'dataArr', internalType: 'bytes[]', type: 'bytes[]' },
      { name: 'receiptHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'executeBatchMulti',
    outputs: [{ name: 'results', internalType: 'bytes[]', type: 'bytes[]' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'asset', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'assertedAPY', internalType: 'uint256', type: 'uint256' },
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'data', internalType: 'bytes', type: 'bytes' },
      { name: 'receiptHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'executeDeposit',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'yieldAsset', internalType: 'address', type: 'address' },
      { name: 'targets', internalType: 'address[]', type: 'address[]' },
      { name: 'dataArr', internalType: 'bytes[]', type: 'bytes[]' },
      { name: 'receiptHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'executeHarvest',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'asset', internalType: 'address', type: 'address' },
      { name: 'deployedAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'data', internalType: 'bytes', type: 'bytes' },
      { name: 'receiptHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'executeWithdraw',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'assets', internalType: 'address[]', type: 'address[]' },
      { name: 'deployedAmounts', internalType: 'uint256[]', type: 'uint256[]' },
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'data', internalType: 'bytes', type: 'bytes' },
      { name: 'receiptHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'executeWithdrawMulti',
    outputs: [
      { name: 'returnedAmounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: 'user', internalType: 'address', type: 'address' }],
    name: 'getExecutionCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'user', internalType: 'address', type: 'address' }],
    name: 'getExecutions',
    outputs: [
      {
        name: '',
        internalType: 'struct YieldGeko.ExecutionRecord[]',
        type: 'tuple[]',
        components: [
          { name: 'receiptHash', internalType: 'bytes32', type: 'bytes32' },
          { name: 'chainId', internalType: 'uint256', type: 'uint256' },
          { name: 'action', internalType: 'string', type: 'string' },
          { name: 'amountUSD', internalType: 'uint256', type: 'uint256' },
          { name: 'timestamp', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
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
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'peakValues',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'pendingOwner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'policies',
    outputs: [
      { name: 'active', internalType: 'bool', type: 'bool' },
      { name: 'managedUSD', internalType: 'uint256', type: 'uint256' },
      { name: 'minAPY', internalType: 'uint256', type: 'uint256' },
      { name: 'maxDrawdownBps', internalType: 'uint256', type: 'uint256' },
      { name: 'maxFeeBps', internalType: 'uint256', type: 'uint256' },
      { name: 'registeredAt', internalType: 'uint256', type: 'uint256' },
      { name: 'expiresAt', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'protectedAsset',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'receiptHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'chainId', internalType: 'uint256', type: 'uint256' },
      { name: 'action', internalType: 'string', type: 'string' },
      { name: 'amountUSD', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'recordExecution',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '_p',
        internalType: 'struct YieldGeko.Policy',
        type: 'tuple',
        components: [
          { name: 'user', internalType: 'address', type: 'address' },
          { name: 'managedUSD', internalType: 'uint256', type: 'uint256' },
          { name: 'minAPY', internalType: 'uint256', type: 'uint256' },
          { name: 'maxDrawdownBps', internalType: 'uint256', type: 'uint256' },
          { name: 'maxFeeBps', internalType: 'uint256', type: 'uint256' },
          { name: 'nonce', internalType: 'uint256', type: 'uint256' },
          { name: 'deadline', internalType: 'uint256', type: 'uint256' },
        ],
      },
      { name: '_sig', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'registerPolicy',
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
    inputs: [
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'currentValueUSD', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'reportValue',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'user', internalType: 'address', type: 'address' }],
    name: 'resumeUser',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'revokePolicy',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'chainId', internalType: 'uint256', type: 'uint256' },
      { name: 'target', internalType: 'address', type: 'address' },
    ],
    name: 'revokeTarget',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_agent', internalType: 'address', type: 'address' }],
    name: 'setAgent',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_feeBps', internalType: 'uint256', type: 'uint256' }],
    name: 'setDefaultFeeBps',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'enabled', internalType: 'bool', type: 'bool' }],
    name: 'setEmergencyMode',
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
      { name: 'user', internalType: 'address', type: 'address' },
      { name: 'asset', internalType: 'address', type: 'address' },
    ],
    name: 'totalFunds',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'address', type: 'address' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    name: 'trackedSpenderAsset',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
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
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'userPaused',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'data', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'vaultSetup',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'asset', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'target',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'receiptHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'timestamp',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'ActionExecuted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'agent',
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
        name: 'steps',
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
    name: 'BatchExecuted',
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
      { name: 'enabled', internalType: 'bool', type: 'bool', indexed: false },
    ],
    name: 'EmergencyModeSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'receiptHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'action',
        internalType: 'string',
        type: 'string',
        indexed: false,
      },
      {
        name: 'amountUSD',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'ExecutionRecorded',
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
      { name: 'fee', internalType: 'uint256', type: 'uint256', indexed: false },
    ],
    name: 'FeeCollected',
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
    name: 'FundsDeployed',
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
        name: 'actual',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'FundsReturned',
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
    name: 'OwnershipTransferStarted',
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
        name: 'managedUSD',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'maxDrawdownBps',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'expiresAt',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'PolicyRegistered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
    ],
    name: 'PolicyRevoked',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'chainId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'target',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'TargetApproved',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'chainId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'target',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'TargetRevoked',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'treasury',
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
        name: 'drawdownBps',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'maxBps',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'UserAutoPaused',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
    ],
    name: 'UserResumed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'currentValueUSD',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'peakValueUSD',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'ValueReported',
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
  {
    type: 'error',
    inputs: [
      { name: 'asserted', internalType: 'uint256', type: 'uint256' },
      { name: 'required', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'APYTooLow',
  },
  {
    type: 'error',
    inputs: [
      { name: 'bps', internalType: 'uint256', type: 'uint256' },
      { name: 'maxBps', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'DrawdownTooHigh',
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
  { type: 'error', inputs: [], name: 'EmergencyModeOff' },
  { type: 'error', inputs: [], name: 'EnforcedPause' },
  {
    type: 'error',
    inputs: [
      { name: 'total', internalType: 'uint256', type: 'uint256' },
      { name: 'cap', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'ExceedsManagedCapacity',
  },
  { type: 'error', inputs: [], name: 'ExpectedPause' },
  {
    type: 'error',
    inputs: [
      { name: 'bps', internalType: 'uint256', type: 'uint256' },
      { name: 'maxBps', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'FeeTooHigh',
  },
  {
    type: 'error',
    inputs: [
      { name: 'have', internalType: 'uint256', type: 'uint256' },
      { name: 'need', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'InsufficientBalance',
  },
  { type: 'error', inputs: [], name: 'InvalidShortString' },
  { type: 'error', inputs: [], name: 'InvalidSignature' },
  { type: 'error', inputs: [], name: 'LengthMismatch' },
  { type: 'error', inputs: [], name: 'NotAgent' },
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
  { type: 'error', inputs: [], name: 'PolicyExpired' },
  { type: 'error', inputs: [], name: 'PolicyNotActive' },
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
  {
    type: 'error',
    inputs: [{ name: 'target', internalType: 'address', type: 'address' }],
    name: 'TargetNotApproved',
  },
  { type: 'error', inputs: [], name: 'UnsafeGenericExecution' },
  {
    type: 'error',
    inputs: [{ name: 'user', internalType: 'address', type: 'address' }],
    name: 'UserPausedByDrawdown',
  },
  { type: 'error', inputs: [], name: 'ZeroAddress' },
  { type: 'error', inputs: [], name: 'ZeroAmount' },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// React
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__
 */
export const useReadYieldGeko = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"MAX_DRAWDOWN_BPS"`
 */
export const useReadYieldGekoMaxDrawdownBps =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'MAX_DRAWDOWN_BPS',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"MAX_FEE_BPS"`
 */
export const useReadYieldGekoMaxFeeBps = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'MAX_FEE_BPS',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"MAX_POLICY_DURATION"`
 */
export const useReadYieldGekoMaxPolicyDuration =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'MAX_POLICY_DURATION',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"POLICY_TYPEHASH"`
 */
export const useReadYieldGekoPolicyTypehash =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'POLICY_TYPEHASH',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"approvedTargets"`
 */
export const useReadYieldGekoApprovedTargets =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'approvedTargets',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"authorizedAgent"`
 */
export const useReadYieldGekoAuthorizedAgent =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'authorizedAgent',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"balances"`
 */
export const useReadYieldGekoBalances = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'balances',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"defaultFeeBps"`
 */
export const useReadYieldGekoDefaultFeeBps =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'defaultFeeBps',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"deployed"`
 */
export const useReadYieldGekoDeployed = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'deployed',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"domainSeparator"`
 */
export const useReadYieldGekoDomainSeparator =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'domainSeparator',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"eip712Domain"`
 */
export const useReadYieldGekoEip712Domain = /*#__PURE__*/ createUseReadContract(
  { abi: yieldGekoAbi, functionName: 'eip712Domain' },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"emergencyMode"`
 */
export const useReadYieldGekoEmergencyMode =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'emergencyMode',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"getExecutionCount"`
 */
export const useReadYieldGekoGetExecutionCount =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'getExecutionCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"getExecutions"`
 */
export const useReadYieldGekoGetExecutions =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'getExecutions',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"nonces"`
 */
export const useReadYieldGekoNonces = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'nonces',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"owner"`
 */
export const useReadYieldGekoOwner = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'owner',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"paused"`
 */
export const useReadYieldGekoPaused = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'paused',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"peakValues"`
 */
export const useReadYieldGekoPeakValues = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'peakValues',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"pendingOwner"`
 */
export const useReadYieldGekoPendingOwner = /*#__PURE__*/ createUseReadContract(
  { abi: yieldGekoAbi, functionName: 'pendingOwner' },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"policies"`
 */
export const useReadYieldGekoPolicies = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'policies',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"protectedAsset"`
 */
export const useReadYieldGekoProtectedAsset =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'protectedAsset',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"totalFunds"`
 */
export const useReadYieldGekoTotalFunds = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'totalFunds',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"trackedSpenderAsset"`
 */
export const useReadYieldGekoTrackedSpenderAsset =
  /*#__PURE__*/ createUseReadContract({
    abi: yieldGekoAbi,
    functionName: 'trackedSpenderAsset',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"treasury"`
 */
export const useReadYieldGekoTreasury = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'treasury',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"userPaused"`
 */
export const useReadYieldGekoUserPaused = /*#__PURE__*/ createUseReadContract({
  abi: yieldGekoAbi,
  functionName: 'userPaused',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__
 */
export const useWriteYieldGeko = /*#__PURE__*/ createUseWriteContract({
  abi: yieldGekoAbi,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"acceptOwnership"`
 */
export const useWriteYieldGekoAcceptOwnership =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'acceptOwnership',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"approveTarget"`
 */
export const useWriteYieldGekoApproveTarget =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'approveTarget',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"approveToken"`
 */
export const useWriteYieldGekoApproveToken =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'approveToken',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"collectFee"`
 */
export const useWriteYieldGekoCollectFee = /*#__PURE__*/ createUseWriteContract(
  { abi: yieldGekoAbi, functionName: 'collectFee' },
)

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"deposit"`
 */
export const useWriteYieldGekoDeposit = /*#__PURE__*/ createUseWriteContract({
  abi: yieldGekoAbi,
  functionName: 'deposit',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"emergencyWithdraw"`
 */
export const useWriteYieldGekoEmergencyWithdraw =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'emergencyWithdraw',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"execute"`
 */
export const useWriteYieldGekoExecute = /*#__PURE__*/ createUseWriteContract({
  abi: yieldGekoAbi,
  functionName: 'execute',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeBatch"`
 */
export const useWriteYieldGekoExecuteBatch =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'executeBatch',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeBatchMulti"`
 */
export const useWriteYieldGekoExecuteBatchMulti =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'executeBatchMulti',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeDeposit"`
 */
export const useWriteYieldGekoExecuteDeposit =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'executeDeposit',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeHarvest"`
 */
export const useWriteYieldGekoExecuteHarvest =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'executeHarvest',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeWithdraw"`
 */
export const useWriteYieldGekoExecuteWithdraw =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'executeWithdraw',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeWithdrawMulti"`
 */
export const useWriteYieldGekoExecuteWithdrawMulti =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'executeWithdrawMulti',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"pause"`
 */
export const useWriteYieldGekoPause = /*#__PURE__*/ createUseWriteContract({
  abi: yieldGekoAbi,
  functionName: 'pause',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"recordExecution"`
 */
export const useWriteYieldGekoRecordExecution =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'recordExecution',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"registerPolicy"`
 */
export const useWriteYieldGekoRegisterPolicy =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'registerPolicy',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"renounceOwnership"`
 */
export const useWriteYieldGekoRenounceOwnership =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'renounceOwnership',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"reportValue"`
 */
export const useWriteYieldGekoReportValue =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'reportValue',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"resumeUser"`
 */
export const useWriteYieldGekoResumeUser = /*#__PURE__*/ createUseWriteContract(
  { abi: yieldGekoAbi, functionName: 'resumeUser' },
)

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"revokePolicy"`
 */
export const useWriteYieldGekoRevokePolicy =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'revokePolicy',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"revokeTarget"`
 */
export const useWriteYieldGekoRevokeTarget =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'revokeTarget',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"setAgent"`
 */
export const useWriteYieldGekoSetAgent = /*#__PURE__*/ createUseWriteContract({
  abi: yieldGekoAbi,
  functionName: 'setAgent',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"setDefaultFeeBps"`
 */
export const useWriteYieldGekoSetDefaultFeeBps =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'setDefaultFeeBps',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"setEmergencyMode"`
 */
export const useWriteYieldGekoSetEmergencyMode =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'setEmergencyMode',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"setTreasury"`
 */
export const useWriteYieldGekoSetTreasury =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'setTreasury',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"transferOwnership"`
 */
export const useWriteYieldGekoTransferOwnership =
  /*#__PURE__*/ createUseWriteContract({
    abi: yieldGekoAbi,
    functionName: 'transferOwnership',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"unpause"`
 */
export const useWriteYieldGekoUnpause = /*#__PURE__*/ createUseWriteContract({
  abi: yieldGekoAbi,
  functionName: 'unpause',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"vaultSetup"`
 */
export const useWriteYieldGekoVaultSetup = /*#__PURE__*/ createUseWriteContract(
  { abi: yieldGekoAbi, functionName: 'vaultSetup' },
)

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"withdraw"`
 */
export const useWriteYieldGekoWithdraw = /*#__PURE__*/ createUseWriteContract({
  abi: yieldGekoAbi,
  functionName: 'withdraw',
})

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__
 */
export const useSimulateYieldGeko = /*#__PURE__*/ createUseSimulateContract({
  abi: yieldGekoAbi,
})

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"acceptOwnership"`
 */
export const useSimulateYieldGekoAcceptOwnership =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'acceptOwnership',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"approveTarget"`
 */
export const useSimulateYieldGekoApproveTarget =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'approveTarget',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"approveToken"`
 */
export const useSimulateYieldGekoApproveToken =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'approveToken',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"collectFee"`
 */
export const useSimulateYieldGekoCollectFee =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'collectFee',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"deposit"`
 */
export const useSimulateYieldGekoDeposit =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'deposit',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"emergencyWithdraw"`
 */
export const useSimulateYieldGekoEmergencyWithdraw =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'emergencyWithdraw',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"execute"`
 */
export const useSimulateYieldGekoExecute =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'execute',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeBatch"`
 */
export const useSimulateYieldGekoExecuteBatch =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'executeBatch',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeBatchMulti"`
 */
export const useSimulateYieldGekoExecuteBatchMulti =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'executeBatchMulti',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeDeposit"`
 */
export const useSimulateYieldGekoExecuteDeposit =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'executeDeposit',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeHarvest"`
 */
export const useSimulateYieldGekoExecuteHarvest =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'executeHarvest',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeWithdraw"`
 */
export const useSimulateYieldGekoExecuteWithdraw =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'executeWithdraw',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"executeWithdrawMulti"`
 */
export const useSimulateYieldGekoExecuteWithdrawMulti =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'executeWithdrawMulti',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"pause"`
 */
export const useSimulateYieldGekoPause =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'pause',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"recordExecution"`
 */
export const useSimulateYieldGekoRecordExecution =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'recordExecution',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"registerPolicy"`
 */
export const useSimulateYieldGekoRegisterPolicy =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'registerPolicy',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"renounceOwnership"`
 */
export const useSimulateYieldGekoRenounceOwnership =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'renounceOwnership',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"reportValue"`
 */
export const useSimulateYieldGekoReportValue =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'reportValue',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"resumeUser"`
 */
export const useSimulateYieldGekoResumeUser =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'resumeUser',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"revokePolicy"`
 */
export const useSimulateYieldGekoRevokePolicy =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'revokePolicy',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"revokeTarget"`
 */
export const useSimulateYieldGekoRevokeTarget =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'revokeTarget',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"setAgent"`
 */
export const useSimulateYieldGekoSetAgent =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'setAgent',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"setDefaultFeeBps"`
 */
export const useSimulateYieldGekoSetDefaultFeeBps =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'setDefaultFeeBps',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"setEmergencyMode"`
 */
export const useSimulateYieldGekoSetEmergencyMode =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'setEmergencyMode',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"setTreasury"`
 */
export const useSimulateYieldGekoSetTreasury =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'setTreasury',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"transferOwnership"`
 */
export const useSimulateYieldGekoTransferOwnership =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'transferOwnership',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"unpause"`
 */
export const useSimulateYieldGekoUnpause =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'unpause',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"vaultSetup"`
 */
export const useSimulateYieldGekoVaultSetup =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'vaultSetup',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link yieldGekoAbi}__ and `functionName` set to `"withdraw"`
 */
export const useSimulateYieldGekoWithdraw =
  /*#__PURE__*/ createUseSimulateContract({
    abi: yieldGekoAbi,
    functionName: 'withdraw',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__
 */
export const useWatchYieldGekoEvent = /*#__PURE__*/ createUseWatchContractEvent(
  { abi: yieldGekoAbi },
)

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"ActionExecuted"`
 */
export const useWatchYieldGekoActionExecutedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'ActionExecuted',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"AgentUpdated"`
 */
export const useWatchYieldGekoAgentUpdatedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'AgentUpdated',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"BatchExecuted"`
 */
export const useWatchYieldGekoBatchExecutedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'BatchExecuted',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"Deposited"`
 */
export const useWatchYieldGekoDepositedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'Deposited',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"EIP712DomainChanged"`
 */
export const useWatchYieldGekoEip712DomainChangedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'EIP712DomainChanged',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"EmergencyModeSet"`
 */
export const useWatchYieldGekoEmergencyModeSetEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'EmergencyModeSet',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"ExecutionRecorded"`
 */
export const useWatchYieldGekoExecutionRecordedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'ExecutionRecorded',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"FeeCollected"`
 */
export const useWatchYieldGekoFeeCollectedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'FeeCollected',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"FundsDeployed"`
 */
export const useWatchYieldGekoFundsDeployedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'FundsDeployed',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"FundsReturned"`
 */
export const useWatchYieldGekoFundsReturnedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'FundsReturned',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"OwnershipTransferStarted"`
 */
export const useWatchYieldGekoOwnershipTransferStartedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'OwnershipTransferStarted',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"OwnershipTransferred"`
 */
export const useWatchYieldGekoOwnershipTransferredEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'OwnershipTransferred',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"Paused"`
 */
export const useWatchYieldGekoPausedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'Paused',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"PolicyRegistered"`
 */
export const useWatchYieldGekoPolicyRegisteredEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'PolicyRegistered',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"PolicyRevoked"`
 */
export const useWatchYieldGekoPolicyRevokedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'PolicyRevoked',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"TargetApproved"`
 */
export const useWatchYieldGekoTargetApprovedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'TargetApproved',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"TargetRevoked"`
 */
export const useWatchYieldGekoTargetRevokedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'TargetRevoked',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"TreasuryUpdated"`
 */
export const useWatchYieldGekoTreasuryUpdatedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'TreasuryUpdated',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"Unpaused"`
 */
export const useWatchYieldGekoUnpausedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'Unpaused',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"UserAutoPaused"`
 */
export const useWatchYieldGekoUserAutoPausedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'UserAutoPaused',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"UserResumed"`
 */
export const useWatchYieldGekoUserResumedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'UserResumed',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"ValueReported"`
 */
export const useWatchYieldGekoValueReportedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'ValueReported',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link yieldGekoAbi}__ and `eventName` set to `"Withdrawn"`
 */
export const useWatchYieldGekoWithdrawnEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: yieldGekoAbi,
    eventName: 'Withdrawn',
  })
