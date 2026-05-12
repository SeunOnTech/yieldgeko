/**
 * DelegationClient — V2 on-chain execution via ERC-7710 delegations.
 *
 * Replaces the direct vault calls (V1) with DelegationManager.redeemDelegations().
 * The agent (delegate) redeems a user-signed delegation which triggers the
 * policy enforcer hooks and executes via the user's MetaMask smart account.
 *
 * Flow per execution:
 *   1. Agent builds executor.executeWithPull(token, amount, protocol, calldata)
 *   2. Wraps in ERC-7579 single execution encoding
 *   3. Encodes permissionContext = abi.encode(Delegation[]) with updated ExecutionArgs
 *   4. Calls DelegationManager.redeemDelegations(permissionContexts, modes, executions)
 */

import { ethers } from 'ethers';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredCaveat {
  enforcer: string;
  terms:    string;   // hex-encoded bytes
  args:     string;   // hex-encoded bytes (empty at signing time — set at redemption)
}

/** A signed ERC-7710 delegation stored per user */
export interface StoredDelegation {
  delegate:         string;   // agent's Pimlico smart account address
  delegator:        string;   // user's MetaMask HybridDeleGator address
  authority:        string;   // ROOT_AUTHORITY = 0xffffffff...
  caveats:          StoredCaveat[];
  salt:             string;   // bytes32 as hex
  signature:        string;   // EIP-712 signature from smart account
  // Runtime tracking
  delegationHash?:  string;   // computed once and cached
  preValueUSD6?:    bigint;   // last known portfolio value (updated each tick)
}

/** ExecutionArgs passed to YieldGekoPolicyCaveatEnforcer at redemption time */
export interface ExecutionArgs {
  preValueUSD6:    bigint;  // portfolio USD value before execution (6 decimals)
  postValueUSD6:   bigint;  // portfolio USD value after execution (6 decimals)
  feeAmountToken:  bigint;  // performance fee in feeToken decimals (0 if no fee)
}

// ─────────────────────────────────────────────────────────────────────────────
// ABIs
// ─────────────────────────────────────────────────────────────────────────────

const EXECUTOR_IFACE = new ethers.Interface([
  'function execute(address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
  'function executeWithPull(address token, uint256 amount, address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
  'function executeWithPullTwo(address token0, uint256 amount0, address token1, uint256 amount1, address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
  // V2 new: tokens arrive from Swapper directly into executor, no pull from smart account needed
  'function executeFromBalance(address token0, address token1, address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
  // V2 new: pull one token from smart account (USDC for LP leg) + use balance token (volatile from Swapper)
  'function executePullAndFromBalance(address pullToken, uint256 pullAmount, address balanceToken, address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
  'function approveToken(address token, address protocol, uint256 amount) external',
]);

const SWAPPER_IFACE = new ethers.Interface([
  'function swap(address dex, bytes calldata data, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient) external payable returns (uint256)',
]);

const ERC20_IFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount) external returns (bool)',
]);

const SWAP_ROUTER02_IFACE = new ethers.Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external returns (uint256)',
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) external returns (uint256)',
]);

const DM_IFACE = new ethers.Interface([
  'function redeemDelegations(bytes[] calldata permissionContexts, bytes32[] calldata modes, bytes[] calldata executionCalldatas) external',
]);

// ERC-7579 execution modes
const MODE_SINGLE = ethers.zeroPadValue('0x', 32) as `0x${string}`;
// CALLTYPE_BATCH (0x01) | EXECTYPE_DEFAULT (0x00) | rest 0
const MODE_BATCH  = ('0x0100000000000000000000000000000000000000000000000000000000000000') as `0x${string}`;

// Delegation tuple ABI type for permissionContext encoding
const DELEGATION_TUPLE_TYPE = `tuple(
  address delegate,
  address delegator,
  bytes32 authority,
  tuple(address enforcer, bytes terms, bytes args)[] caveats,
  uint256 salt,
  bytes signature
)[]`;

// ─────────────────────────────────────────────────────────────────────────────
// DelegationClient
// ─────────────────────────────────────────────────────────────────────────────

export class DelegationClient {
  private readonly store = new Map<string, StoredDelegation>();
  private readonly executorAddress: string;
  private readonly delegationManagerAddress: string;

  // Policy enforcer is the only caveat — AllowedTargets was removed because it throws
  // CaveatEnforcer:invalid-call-type on BATCH mode (3-exec delta-neutral path).
  private readonly POLICY_ENFORCER_CAVEAT_INDEX = 0;

  constructor(executorAddress: string, delegationManagerAddress: string) {
    this.executorAddress         = executorAddress;
    this.delegationManagerAddress = delegationManagerAddress;
  }

  // ─── Delegation storage ──────────────────────────────────────────────────

  setDelegation(userId: string, delegation: StoredDelegation): void {
    this.store.set(userId, delegation);
  }

  getDelegation(userId: string): StoredDelegation | null {
    return this.store.get(userId) ?? null;
  }

  hasDelegation(userId: string): boolean {
    return this.store.has(userId);
  }

  updatePreValue(userId: string, preValueUSD6: bigint): void {
    const d = this.store.get(userId);
    if (d) d.preValueUSD6 = preValueUSD6;
  }

  // ─── Calldata builders ───────────────────────────────────────────────────

  /**
   * Build the full redeemDelegations calldata for a token deposit execution.
   *
   * The execution runs FROM the user's smart account:
   *   smart account → executor.executeWithPull(token, amount, protocol, protocolCalldata, value)
   *   executor pulls token from smart account (pre-approved), approves protocol, deposits.
   *
   * @param userId           user ID to look up stored delegation
   * @param token            ERC-20 to pull from smart account (USDC)
   * @param tokenAmount      amount to pull (in token decimals)
   * @param protocolAddress  approved DeFi protocol (e.g. Aave Pool)
   * @param protocolCalldata ABI-encoded protocol function call
   * @param protocolValue    native ETH to forward (0 for ERC-20 protocols)
   * @param executionArgs    pre/post USD values + fee (for policy enforcer)
   */
  buildDepositCalldata(params: {
    userId:            string;
    token:             string;
    tokenAmount:       bigint;
    protocolAddress:   string;
    protocolCalldata:  string;
    protocolValue:     bigint;
    executionArgs:     ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    const executorCalldata = EXECUTOR_IFACE.encodeFunctionData('executeWithPull', [
      params.token,
      params.tokenAmount,
      params.protocolAddress,
      params.protocolCalldata,
      params.protocolValue,
    ]);

    return this._buildRedeemCalldata(delegation, this.executorAddress, executorCalldata, 0n, params.executionArgs);
  }

  /**
   * Build redeemDelegations calldata for a SWAP then DEPOSIT in batch.
   * Used for non-USDC single-token strategies (e.g. USDC→WETH then deposit to Aave/Pendle).
   *
   * Batch:
   *   Execution 1: Swapper.swap(dex, calldata, USDC, tokenOut, amountIn, minOut, SmartAccount)
   *   Execution 2: Executor.executeWithPull(tokenOut, minOut, protocol, depositCalldata)
   */
  buildSwapAndDepositCalldata(params: {
    userId:            string;
    // swap leg
    swapperAddress:    string;
    dex:               string;
    swapCalldata:      string;
    tokenIn:           string;
    tokenOut:          string;
    swapAmountIn:      bigint;
    swapMinOut:        bigint;
    // deposit leg
    protocolAddress:   string;
    depositCalldata:   string;
    protocolValue:     bigint;
    executionArgs:     ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    // Execution 1: swap via Swapper — recipient is smart account (delegator)
    const swapCd = SWAPPER_IFACE.encodeFunctionData('swap', [
      params.dex,
      params.swapCalldata,
      params.tokenIn,
      params.tokenOut,
      params.swapAmountIn,
      params.swapMinOut,
      delegation.delegator,  // SmartAccount receives tokenOut
    ]);
    const swapExec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [params.swapperAddress, 0n, ethers.getBytes(swapCd)],
    );

    // Execution 2: deposit tokenOut via Executor.executeWithPull
    const depositCd = EXECUTOR_IFACE.encodeFunctionData('executeWithPull', [
      params.tokenOut,
      params.swapMinOut,      // use minOut so we never over-pull
      params.protocolAddress,
      params.depositCalldata,
      params.protocolValue,
    ]);
    const depositExec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [this.executorAddress, 0n, ethers.getBytes(depositCd)],
    );

    return this._buildRedeemCalldataBatch(
      delegation,
      [swapExec, depositExec],
      params.executionArgs,
    );
  }

  /**
   * Build redeemDelegations calldata for delta-neutral LP mint on a USDC pair.
   * (e.g. WETH/USDC or WBTC/USDC where one token is USDC — only one swap needed)
   *
   * Batch:
   *   Execution 1: Swapper.swap(USDC → token0, half capital, SmartAccount)
   *   Execution 2: Executor.executeWithPullTwo(token0, amount0, USDC, amount1, UniV3, mint)
   */
  buildDeltaNeutralUsdcPairCalldata(params: {
    userId:            string;
    swapperAddress:    string;
    dex:               string;
    swapCalldata:      string;   // USDC → token0
    token0:            string;   // volatile token (WETH, WBTC, ARB)
    token0MinOut:      bigint;
    usdcAddress:       string;
    usdcAmount:        bigint;   // remaining USDC for LP
    usdcSwapIn:        bigint;   // USDC used for swap
    protocolAddress:   string;   // UniV3 NonfungiblePositionManager
    mintCalldata:      string;
    executionArgs:     ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    // Execution 1: swap half USDC → token0 — Swapper sends token0 directly to EXECUTOR
    const swapCd = SWAPPER_IFACE.encodeFunctionData('swap', [
      params.dex,
      params.swapCalldata,
      params.usdcAddress,
      params.token0,
      params.usdcSwapIn,
      params.token0MinOut,
      this.executorAddress,  // recipient = executor (not smart account)
    ]);
    const swapExec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [params.swapperAddress, 0n, ethers.getBytes(swapCd)],
    );

    // Execution 2: pull remaining USDC from smart account + use token0 already in executor
    //   executePullAndFromBalance: pulls USDC from smart account, uses token0 from executor balance
    //   dust swept to treasury after mint
    const mintCd = EXECUTOR_IFACE.encodeFunctionData('executePullAndFromBalance', [
      params.usdcAddress,   // pullToken  = USDC (pulled from smart account)
      params.usdcAmount,    // pullAmount = remaining USDC for LP leg
      params.token0,        // balanceToken = volatile (already in executor from swap)
      params.protocolAddress,
      params.mintCalldata,
      0n,
    ]);
    const mintExec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [this.executorAddress, 0n, ethers.getBytes(mintCd)],
    );

    return this._buildRedeemCalldataBatch(
      delegation,
      [swapExec, mintExec],
      params.executionArgs,
    );
  }

  /**
   * Build redeemDelegations calldata for delta-neutral LP mint on a non-USDC pair.
   * (e.g. WBTC/WETH, ARB/WETH — both tokens need to be swapped from USDC)
   *
   * Batch:
   *   Execution 1: Swapper.swap(USDC → token0, half capital, SmartAccount)
   *   Execution 2: Swapper.swap(USDC → token1, half capital, SmartAccount)
   *   Execution 3: Executor.executeWithPullTwo(token0, amount0, token1, amount1, UniV3, mint)
   */
  buildDeltaNeutralNonUsdcPairCalldata(params: {
    userId:            string;
    swapperAddress:    string;
    // first swap: USDC → token0
    dex0:              string;
    swapCalldata0:     string;
    token0:            string;
    usdcForToken0:     bigint;
    token0MinOut:      bigint;
    // second swap: USDC → token1
    dex1:              string;
    swapCalldata1:     string;
    token1:            string;
    usdcForToken1:     bigint;
    token1MinOut:      bigint;
    usdcAddress:       string;
    // LP mint
    protocolAddress:   string;
    mintCalldata:      string;
    executionArgs:     ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    // Execution 1: USDC → token0 — Swapper sends token0 directly to EXECUTOR (not smart account)
    const swap0Cd = SWAPPER_IFACE.encodeFunctionData('swap', [
      params.dex0, params.swapCalldata0,
      params.usdcAddress, params.token0,
      params.usdcForToken0, params.token0MinOut,
      this.executorAddress,  // recipient = executor
    ]);
    const swap0Exec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [params.swapperAddress, 0n, ethers.getBytes(swap0Cd)],
    );

    // Execution 2: USDC → token1 — Swapper sends token1 directly to EXECUTOR
    const swap1Cd = SWAPPER_IFACE.encodeFunctionData('swap', [
      params.dex1, params.swapCalldata1,
      params.usdcAddress, params.token1,
      params.usdcForToken1, params.token1MinOut,
      this.executorAddress,  // recipient = executor
    ]);
    const swap1Exec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [params.swapperAddress, 0n, ethers.getBytes(swap1Cd)],
    );

    // Execution 3: both tokens already in executor — use executeFromBalance (dust swept to treasury)
    const mintCd = EXECUTOR_IFACE.encodeFunctionData('executeFromBalance', [
      params.token0,
      params.token1,
      params.protocolAddress,
      params.mintCalldata,
      0n,
    ]);
    const mintExec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [this.executorAddress, 0n, ethers.getBytes(mintCd)],
    );

    return this._buildRedeemCalldataBatch(
      delegation,
      [swap0Exec, swap1Exec, mintExec],
      params.executionArgs,
    );
  }

  /**
   * Build redeemDelegations calldata for a withdrawal/close execution.
   * Withdrawals don't pull tokens (executor calls protocol which returns tokens to smart account).
   */
  buildWithdrawCalldata(params: {
    userId:            string;
    protocolAddress:   string;
    protocolCalldata:  string;
    protocolValue:     bigint;
    executionArgs:     ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    // For withdrawals: smart account calls the protocol directly (not via executor).
    // For UniV3 positions, the smart account IS the NFT owner — it can call
    // decreaseLiquidity / collect directly. No onlyAuthorized restriction applies.
    return this._buildRedeemCalldata(delegation, params.protocolAddress, params.protocolCalldata, params.protocolValue, params.executionArgs);
  }

  /**
   * Build redeemDelegations calldata for multiple approvals (EXECUTOR + SWAPPER).
   * Used during V2 preparation.
   */
  buildApprovalBatchCalldata(params: {
    userId:          string;
    approvals:       Array<{ token: string; spender: string; amount: bigint }>;
    executionArgs:   ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    const executions: string[] = params.approvals.map(app => {
      const cd = ERC20_IFACE.encodeFunctionData('approve', [app.spender, app.amount]);
      return ethers.solidityPacked(
        ['address', 'uint256', 'bytes'],
        [app.token, 0n, ethers.getBytes(cd)],
      );
    });

    return this._buildRedeemCalldataBatch(delegation, executions, params.executionArgs);
  }

  /**
   * Build redeemDelegations calldata for a generic protocol call (harvest, claim, etc.)
   */
  buildGenericCalldata(params: {
    userId:           string;
    protocolAddress:  string;
    protocolCalldata: string;
    protocolValue:    bigint;
    executionArgs:    ExecutionArgs;
  }): string {
    return this.buildWithdrawCalldata(params);
  }


  /**
   * Build redeemDelegations BATCH calldata that swaps volatile tokens → USDC.
   * Used after closing a non-USDC LP position: smart account has token0 + token1,
   * needs to convert both to USDC before re-entering a position.
   *
   * Each token generates 2 executions:
   *   1. ERC20.approve(swapRouter, MaxUint256)   — smart account approves router
   *   2. SwapRouter.exactInputSingle(token→USDC) — smart account swaps, USDC to recipient
   */
  /**
   * Build redeemDelegations BATCH calldata that swaps volatile tokens → USDC via the Swapper.
   *
   * Flow per token:
   *   exec 1: smart account → ERC20.approve(swapper, MaxUint256)
   *   exec 2: smart account → Swapper.swap(dex, dexCalldata, tokenIn, USDC, amount, minOut, recipient)
   *             Swapper internally: transferFrom(smartAccount) → DEX swap → forward USDC to recipient
   *
   * IMPORTANT: dexCalldata must have recipient = swapperAddress (Swapper measures balance delta).
   * minOut = 0 is acceptable here (close→normalize→redeposit is a rebalance, not a user withdrawal).
   */
  buildNormalizeCalldata(params: {
    userId:          string;
    swapperAddress:  string;
    tokens:          Array<{
      address:     string;    // volatile token to swap → USDC
      amount:      bigint;    // amount to swap
      dexAddress:  string;    // approved DEX (e.g. SwapRouter02)
      dexCalldata: string;    // DEX calldata; recipient MUST be swapperAddress
      minOut:      bigint;    // minimum USDC out (slippage floor)
    }>;
    usdcAddress:     string;
    recipient:       string;  // final USDC recipient (EOA on withdraw, smart account on migrate)
    executionArgs:   ExecutionArgs;
    usdcSweepAmount?: bigint; // if set, also transfer this much USDC from smart account to recipient
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    const executions: string[] = [];
    for (const tok of params.tokens) {
      if (tok.amount === 0n) continue;

      // 1. smart account approves Swapper to pull tokenIn
      const approveCd = ERC20_IFACE.encodeFunctionData('approve', [params.swapperAddress, ethers.MaxUint256]);
      executions.push(ethers.solidityPacked(
        ['address', 'uint256', 'bytes'],
        [tok.address, 0n, ethers.getBytes(approveCd)],
      ));

      // 2. smart account calls Swapper.swap — Swapper pulls token, calls DEX, forwards USDC to recipient
      const swapCd = SWAPPER_IFACE.encodeFunctionData('swap', [
        tok.dexAddress,
        tok.dexCalldata,
        tok.address,
        params.usdcAddress,
        tok.amount,
        tok.minOut,
        params.recipient,
      ]);
      executions.push(ethers.solidityPacked(
        ['address', 'uint256', 'bytes'],
        [params.swapperAddress, 0n, ethers.getBytes(swapCd)],
      ));
    }

    // Sweep any pre-existing USDC sitting in the smart account to recipient
    if (params.usdcSweepAmount && params.usdcSweepAmount > 0n) {
      const transferCd = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)'])
        .encodeFunctionData('transfer', [params.recipient, params.usdcSweepAmount]);
      executions.push(ethers.solidityPacked(
        ['address', 'uint256', 'bytes'],
        [params.usdcAddress, 0n, ethers.getBytes(transferCd)],
      ));
    }

    if (executions.length === 0) throw new Error('[buildNormalizeCalldata] No tokens or USDC to sweep');

    return this._buildRedeemCalldataBatch(delegation, executions, params.executionArgs);
  }

  // ─── Core encoding ────────────────────────────────────────────────────────

  /**
   * Build redeemDelegations for a BATCH of executions (multiple protocol calls).
   * Uses MODE_BATCH (CALLTYPE_BATCH | EXECTYPE_DEFAULT).
   * Each execution is ERC-7579 encoded: encodePacked(target, value, calldata).
   */
  private _buildRedeemCalldataBatch(
    delegation:  StoredDelegation,
    executions:  string[],  // array of ERC-7579 packed executions
    args:        ExecutionArgs,
  ): string {
    const encodedArgs    = this._encodeExecutionArgs(args);
    const caveatsWithArgs = delegation.caveats.map((c, i) =>
      i === this.POLICY_ENFORCER_CAVEAT_INDEX ? { ...c, args: encodedArgs } : c,
    );
    const delegationWithArgs = { ...delegation, caveats: caveatsWithArgs };
    const permissionContext  = this._encodePermissionContext(delegationWithArgs);

    // Batch execution calldata: abi.encode(Execution[]) where each Execution = (target, value, calldata)
    const batchCalldata = ethers.AbiCoder.defaultAbiCoder().encode(
      ['(address target, uint256 value, bytes callData)[]'],
      [executions.map(exec => {
        // decode the packed execution back into struct form
        const target   = '0x' + exec.slice(2, 42);
        const value    = BigInt('0x' + exec.slice(42, 106));
        const callData = '0x' + exec.slice(106);
        return { target, value, callData };
      })],
    );

    return DM_IFACE.encodeFunctionData('redeemDelegations', [
      [permissionContext],
      [MODE_BATCH],
      [batchCalldata],
    ]);
  }

  private _buildRedeemCalldata(
    delegation:      StoredDelegation,
    executionTarget: string,
    executionCd:     string,
    executionValue:  bigint,
    args:            ExecutionArgs,
  ): string {
    // 1. Inject ExecutionArgs into the policy enforcer caveat's args field
    const encodedArgs = this._encodeExecutionArgs(args);
    const caveatsWithArgs = delegation.caveats.map((c, i) =>
      i === this.POLICY_ENFORCER_CAVEAT_INDEX
        ? { ...c, args: encodedArgs }
        : c
    );
    const delegationWithArgs = { ...delegation, caveats: caveatsWithArgs };

    // 2. Encode permissionContext = abi.encode(Delegation[])
    const permissionContext = this._encodePermissionContext(delegationWithArgs);

    // 3. Encode ERC-7579 single execution: encodePacked(target, value, calldata)
    const executionCalldata = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [executionTarget, executionValue, ethers.getBytes(executionCd)],
    );

    // 4. Encode redeemDelegations call
    return DM_IFACE.encodeFunctionData('redeemDelegations', [
      [permissionContext],          // bytes[] permissionContexts
      [MODE_SINGLE],                // bytes32[] modes
      [executionCalldata],          // bytes[] executionCalldatas
    ]);
  }

  /**
   * Encode the ExecutionArgs struct for the YieldGekoPolicyCaveatEnforcer.
   * Must match: abi.encode(uint256 preValueUSD6, uint256 postValueUSD6, uint256 feeAmountToken)
   */
  private _encodeExecutionArgs(args: ExecutionArgs): string {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'uint256'],
      [args.preValueUSD6, args.postValueUSD6, args.feeAmountToken],
    );
  }

  /**
   * Encode a Delegation as permissionContext = abi.encode(Delegation[]).
   * Must match exactly what DelegationManager.redeemDelegations expects.
   */
  private _encodePermissionContext(d: StoredDelegation): string {
    const caveats = d.caveats.map(c => ({
      enforcer: c.enforcer,
      terms:    c.terms,
      args:     c.args,
    }));

    // Normalise salt: '0x' (empty) is not a valid uint256 — use 0n
    const salt = (!d.salt || d.salt === '0x') ? 0n : d.salt;
    return ethers.AbiCoder.defaultAbiCoder().encode(
      [DELEGATION_TUPLE_TYPE],
      [[{
        delegate:  d.delegate,
        delegator: d.delegator,
        authority: d.authority,
        caveats,
        salt,
        signature: d.signature,
      }]],
    );
  }

  // ─── Utility ─────────────────────────────────────────────────────────────

  /** Encode approveToken calldata for direct agent call (not via delegation) */
  encodeApproveToken(token: string, protocol: string, amount: bigint): string {
    return EXECUTOR_IFACE.encodeFunctionData('approveToken', [token, protocol, amount]);
  }

  get dmAddress(): string { return this.delegationManagerAddress; }
  get execAddress(): string { return this.executorAddress; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for building ExecutionArgs from agent context
// ─────────────────────────────────────────────────────────────────────────────

/** Build ExecutionArgs for a deposit (no yield yet, no fee) */
export function depositArgs(portfolioValueUSD: number): ExecutionArgs {
  const usd6 = BigInt(Math.round(portfolioValueUSD * 1e6));
  return { preValueUSD6: usd6, postValueUSD6: usd6, feeAmountToken: 0n };
}

/** Build ExecutionArgs for a harvest / compound (yield realized, fee calculated) */
export function harvestArgs(params: {
  preValueUSD:  number;
  postValueUSD: number;
  maxFeeBps:    number;    // from user policy (e.g. 1500 = 15%)
  feeTokenDecimals: number; // 6 for USDC
}): ExecutionArgs {
  const { preValueUSD, postValueUSD, maxFeeBps, feeTokenDecimals } = params;
  const pre6  = BigInt(Math.round(preValueUSD  * 1e6));
  const post6 = BigInt(Math.round(postValueUSD * 1e6));

  let feeAmountToken = 0n;
  if (postValueUSD > preValueUSD) {
    const yieldUSD   = postValueUSD - preValueUSD;
    const feeUSD     = yieldUSD * (maxFeeBps / 10_000) * 0.99; // 1% safety margin below max
    const feeFactor  = Math.pow(10, feeTokenDecimals) / 1e6;   // USDC: 1 (both 6 dec)
    feeAmountToken = BigInt(Math.floor(feeUSD * feeFactor * 1e6));
  }

  return { preValueUSD6: pre6, postValueUSD6: post6, feeAmountToken };
}

/** Build ExecutionArgs for a withdrawal (post = 0) */
export function withdrawArgs(portfolioValueBeforeUSD: number): ExecutionArgs {
  const pre6 = BigInt(Math.round(portfolioValueBeforeUSD * 1e6));
  return { preValueUSD6: pre6, postValueUSD6: 0n, feeAmountToken: 0n };
}

/** Build ExecutionArgs for a rebalance (same capital, no fee) */
export function rebalanceArgs(portfolioValueUSD: number): ExecutionArgs {
  return depositArgs(portfolioValueUSD);
}
