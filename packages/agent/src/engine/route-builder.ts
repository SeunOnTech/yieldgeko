import { encodeFunctionData, Hex, parseAbi } from 'viem'

const VAULT_ABI = parseAbi([
  'function executeDeposit(address user, address asset, uint256 amount, uint256 assertedAPY, address target, bytes data, bytes32 receiptHash) external payable',
  'function executeWithdraw(address user, address asset, uint256 deployedAmount, address target, bytes data, bytes32 receiptHash) external payable',
  'function executeWithdrawMulti(address user, address[] assets, uint256[] deployedAmounts, address target, bytes data, bytes32 receiptHash) external payable',
  'function executeBatch(address user, address asset, address[] targets, bytes[] dataArr, bytes32 receiptHash) external',
  'function executeBatchMulti(address user, address[] assets, address[] targets, bytes[] dataArr, bytes32 receiptHash) external',
  'function execute(address user, address target, bytes data, bytes32 receiptHash, address guardAsset) external payable returns (bytes)',
  'function reportValue(address user, uint256 currentValueUSD) external',
])

export class RouteBuilder {
  static depositCalldata(
    user: Hex, asset: Hex, amount: bigint, assertedAPY: bigint,
    target: Hex, calldata: Hex, receiptHash: Hex
  ): Hex {
    return encodeFunctionData({
      abi: VAULT_ABI, functionName: 'executeDeposit',
      args: [user, asset, amount, assertedAPY, target, calldata, receiptHash],
    })
  }

  static withdrawCalldata(
    user: Hex, asset: Hex, deployedAmount: bigint,
    target: Hex, calldata: Hex, receiptHash: Hex
  ): Hex {
    return encodeFunctionData({
      abi: VAULT_ABI, functionName: 'executeWithdraw',
      args: [user, asset, deployedAmount, target, calldata, receiptHash],
    })
  }

  static withdrawMultiCalldata(
    user: Hex, assets: Hex[], deployedAmounts: bigint[],
    target: Hex, calldata: Hex, receiptHash: Hex
  ): Hex {
    return encodeFunctionData({
      abi: VAULT_ABI, functionName: 'executeWithdrawMulti',
      args: [user, assets, deployedAmounts, target, calldata, receiptHash],
    })
  }

  static batchCalldata(
    user: Hex, asset: Hex, targets: Hex[], dataArr: Hex[], receiptHash: Hex
  ): Hex {
    return encodeFunctionData({
      abi: VAULT_ABI, functionName: 'executeBatch',
      args: [user, asset, targets, dataArr, receiptHash],
    })
  }

  static batchMultiCalldata(
    user: Hex, assets: Hex[], targets: Hex[], dataArr: Hex[], receiptHash: Hex
  ): Hex {
    return encodeFunctionData({
      abi: VAULT_ABI, functionName: 'executeBatchMulti',
      args: [user, assets, targets, dataArr, receiptHash],
    })
  }

  static executeCalldata(user: Hex, target: Hex, calldata: Hex, receiptHash: Hex, guardAsset: Hex): Hex {
    return encodeFunctionData({
      abi: VAULT_ABI, functionName: 'execute',
      args: [user, target, calldata, receiptHash, guardAsset],
    })
  }

  static applyGasBuffer(estimate: bigint): bigint {
    return (estimate * 120n) / 100n
  }
}
