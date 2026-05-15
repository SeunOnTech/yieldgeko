

import { ethers } from 'ethers';

export interface StoredCaveat {
  enforcer: string;
  terms:    string;   
  args:     string;   
}

export interface StoredDelegation {
  delegate:         string;   
  delegator:        string;   
  authority:        string;   
  caveats:          StoredCaveat[];
  salt:             string;   
  signature:        string;   
  
  delegationHash?:  string;   
  preValueUSD6?:    bigint;   
}

export interface ExecutionArgs {
  preValueUSD6:    bigint;  
  postValueUSD6:   bigint;  
  feeAmountToken:  bigint;  
}

const EXECUTOR_IFACE = new ethers.Interface([
  'function execute(address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
  'function executeWithPull(address token, uint256 amount, address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
  'function executeWithPullTwo(address token0, uint256 amount0, address token1, uint256 amount1, address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
  
  'function executeFromBalance(address token0, address token1, address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
  
  'function executePullAndFromBalance(address pullToken, uint256 pullAmount, address balanceToken, address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
  'function approveToken(address token, address protocol, uint256 amount) external',
]);

const SWAPPER_IFACE = new ethers.Interface([
  'function swap(address dex, bytes calldata data, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient) external payable returns (uint256)',
]);

const ERC20_IFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function transfer(address to, uint256 amount) external returns (bool)',
]);

const UNIV3_COLLECT_IFACE = new ethers.Interface([
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) external payable returns (uint256,uint256)',
  'function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) external payable returns (uint128,uint256,uint256)',
]);

const EXECUTOR_FROM_BALANCE_IFACE = new ethers.Interface([
  'function executeFromBalance(address token0, address token1, address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory)',
]);

const MAX_UINT128_DC = (2n ** 128n) - 1n;

const SWAP_ROUTER02_IFACE = new ethers.Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external returns (uint256)',
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) external returns (uint256)',
]);

const DM_IFACE = new ethers.Interface([
  'function redeemDelegations(bytes[] calldata permissionContexts, bytes32[] calldata modes, bytes[] calldata executionCalldatas) external',
]);

const MODE_SINGLE = ethers.zeroPadValue('0x', 32) as `0x${string}`;

const MODE_BATCH  = ('0x0100000000000000000000000000000000000000000000000000000000000000') as `0x${string}`;

const DELEGATION_TUPLE_TYPE = `tuple(
  address delegate,
  address delegator,
  bytes32 authority,
  tuple(address enforcer, bytes terms, bytes args)[] caveats,
  uint256 salt,
  bytes signature
)[]`;

export class DelegationClient {
  private readonly store = new Map<string, StoredDelegation>();
  private readonly executorAddress: string;
  private readonly delegationManagerAddress: string;

  
  
  private readonly POLICY_ENFORCER_CAVEAT_INDEX = 0;

  constructor(executorAddress: string, delegationManagerAddress: string) {
    this.executorAddress         = executorAddress;
    this.delegationManagerAddress = delegationManagerAddress;
  }

  

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

  
  buildSwapAndDepositCalldata(params: {
    userId:            string;
    
    swapperAddress:    string;
    dex:               string;
    swapCalldata:      string;
    tokenIn:           string;
    tokenOut:          string;
    swapAmountIn:      bigint;
    swapMinOut:        bigint;
    
    protocolAddress:   string;
    depositCalldata:   string;
    protocolValue:     bigint;
    executionArgs:     ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    
    const swapCd = SWAPPER_IFACE.encodeFunctionData('swap', [
      params.dex,
      params.swapCalldata,
      params.tokenIn,
      params.tokenOut,
      params.swapAmountIn,
      params.swapMinOut,
      delegation.delegator,  
    ]);
    const swapExec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [params.swapperAddress, 0n, ethers.getBytes(swapCd)],
    );

    
    const depositCd = EXECUTOR_IFACE.encodeFunctionData('executeWithPull', [
      params.tokenOut,
      params.swapMinOut,      
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

  
  buildDeltaNeutralUsdcPairCalldata(params: {
    userId:            string;
    swapperAddress:    string;
    dex:               string;
    swapCalldata:      string;   
    token0:            string;   
    token0MinOut:      bigint;
    usdcAddress:       string;
    usdcAmount:        bigint;   
    usdcSwapIn:        bigint;   
    protocolAddress:   string;   
    mintCalldata:      string;
    executionArgs:     ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    
    const swapCd = SWAPPER_IFACE.encodeFunctionData('swap', [
      params.dex,
      params.swapCalldata,
      params.usdcAddress,
      params.token0,
      params.usdcSwapIn,
      params.token0MinOut,
      this.executorAddress,  
    ]);
    const swapExec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [params.swapperAddress, 0n, ethers.getBytes(swapCd)],
    );

    
    
    
    const mintCd = EXECUTOR_IFACE.encodeFunctionData('executePullAndFromBalance', [
      params.usdcAddress,   
      params.usdcAmount,    
      params.token0,        
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

  
  buildDeltaNeutralNonUsdcPairCalldata(params: {
    userId:            string;
    swapperAddress:    string;
    
    dex0:              string;
    swapCalldata0:     string;
    token0:            string;
    usdcForToken0:     bigint;
    token0MinOut:      bigint;
    
    dex1:              string;
    swapCalldata1:     string;
    token1:            string;
    usdcForToken1:     bigint;
    token1MinOut:      bigint;
    usdcAddress:       string;
    
    protocolAddress:   string;
    mintCalldata:      string;
    executionArgs:     ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    
    const swap0Cd = SWAPPER_IFACE.encodeFunctionData('swap', [
      params.dex0, params.swapCalldata0,
      params.usdcAddress, params.token0,
      params.usdcForToken0, params.token0MinOut,
      this.executorAddress,  
    ]);
    const swap0Exec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [params.swapperAddress, 0n, ethers.getBytes(swap0Cd)],
    );

    
    const swap1Cd = SWAPPER_IFACE.encodeFunctionData('swap', [
      params.dex1, params.swapCalldata1,
      params.usdcAddress, params.token1,
      params.usdcForToken1, params.token1MinOut,
      this.executorAddress,  
    ]);
    const swap1Exec = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [params.swapperAddress, 0n, ethers.getBytes(swap1Cd)],
    );

    
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

  
  buildWithdrawCalldata(params: {
    userId:            string;
    protocolAddress:   string;
    protocolCalldata:  string;
    protocolValue:     bigint;
    executionArgs:     ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    
    
    
    return this._buildRedeemCalldata(delegation, params.protocolAddress, params.protocolCalldata, params.protocolValue, params.executionArgs);
  }

  
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

  
  buildGenericCalldata(params: {
    userId:           string;
    protocolAddress:  string;
    protocolCalldata: string;
    protocolValue:    bigint;
    executionArgs:    ExecutionArgs;
  }): string {
    return this.buildWithdrawCalldata(params);
  }

  
  
  buildNormalizeCalldata(params: {
    userId:          string;
    swapperAddress:  string;
    tokens:          Array<{
      address:     string;    
      amount:      bigint;    
      dexAddress:  string;    
      dexCalldata: string;    
      minOut:      bigint;    
    }>;
    usdcAddress:     string;
    recipient:       string;  
    executionArgs:   ExecutionArgs;
    usdcSweepAmount?: bigint; 
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    const executions: string[] = [];
    for (const tok of params.tokens) {
      if (tok.amount === 0n) continue;

      
      const approveCd = ERC20_IFACE.encodeFunctionData('approve', [params.swapperAddress, ethers.MaxUint256]);
      executions.push(ethers.solidityPacked(
        ['address', 'uint256', 'bytes'],
        [tok.address, 0n, ethers.getBytes(approveCd)],
      ));

      
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

  
  buildHarvestCompoundCalldata(params: {
    userId:              string;
    tokenId:             bigint;
    token0:              string;
    token1:              string;
    tokensOwed0:         bigint;   
    tokensOwed1:         bigint;   
    maxFeeBps:           number;   
    treasury:            string;
    executorAddress:     string;
    pmAddress:           string;   
    smartAccountAddress: string;
    executionArgs:       ExecutionArgs;
  }): string {
    const delegation = this.store.get(params.userId);
    if (!delegation) throw new Error(`No delegation found for user: ${params.userId}`);

    
    const feeMul = BigInt(Math.floor(params.maxFeeBps * 99 / 100));  
    const fee0 = (params.tokensOwed0 * feeMul) / 1_000_000n;         
    const fee1 = (params.tokensOwed1 * feeMul) / 1_000_000n;

    
    
    const reinvest0 = params.tokensOwed0 > fee0 ? params.tokensOwed0 - fee0 : 0n;
    const reinvest1 = params.tokensOwed1 > fee1 ? params.tokensOwed1 - fee1 : 0n;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const executions: string[] = [];

    
    
    const collectCd = UNIV3_COLLECT_IFACE.encodeFunctionData('collect', [{
      tokenId:    params.tokenId,
      recipient:  params.smartAccountAddress,
      amount0Max: MAX_UINT128_DC,
      amount1Max: MAX_UINT128_DC,
    }]);
    executions.push(ethers.solidityPacked(['address', 'uint256', 'bytes'],
      [params.pmAddress, 0n, ethers.getBytes(collectCd)]));

    
    if (fee0 > 0n) {
      executions.push(ethers.solidityPacked(['address', 'uint256', 'bytes'], [
        params.token0, 0n,
        ethers.getBytes(ERC20_IFACE.encodeFunctionData('transfer', [params.treasury, fee0])),
      ]));
    }
    if (fee1 > 0n) {
      executions.push(ethers.solidityPacked(['address', 'uint256', 'bytes'], [
        params.token1, 0n,
        ethers.getBytes(ERC20_IFACE.encodeFunctionData('transfer', [params.treasury, fee1])),
      ]));
    }

    
    if (reinvest0 > 0n) {
      executions.push(ethers.solidityPacked(['address', 'uint256', 'bytes'], [
        params.token0, 0n,
        ethers.getBytes(ERC20_IFACE.encodeFunctionData('transfer', [params.executorAddress, reinvest0])),
      ]));
    }
    if (reinvest1 > 0n) {
      executions.push(ethers.solidityPacked(['address', 'uint256', 'bytes'], [
        params.token1, 0n,
        ethers.getBytes(ERC20_IFACE.encodeFunctionData('transfer', [params.executorAddress, reinvest1])),
      ]));
    }

    
    if (reinvest0 > 0n || reinvest1 > 0n) {
      const increaseLiqCd = UNIV3_COLLECT_IFACE.encodeFunctionData('increaseLiquidity', [{
        tokenId:        params.tokenId,
        amount0Desired: reinvest0,
        amount1Desired: reinvest1,
        amount0Min:     0n,
        amount1Min:     0n,
        deadline,
      }]);
      executions.push(ethers.solidityPacked(['address', 'uint256', 'bytes'], [
        params.executorAddress, 0n,
        ethers.getBytes(EXECUTOR_FROM_BALANCE_IFACE.encodeFunctionData('executeFromBalance', [
          params.token0, params.token1, params.pmAddress, increaseLiqCd, 0n,
        ])),
      ]));
    }

    if (executions.length === 0) throw new Error('[buildHarvestCompoundCalldata] Nothing to harvest');
    return this._buildRedeemCalldataBatch(delegation, executions, params.executionArgs);
  }

  

  
  private _buildRedeemCalldataBatch(
    delegation:  StoredDelegation,
    executions:  string[],  
    args:        ExecutionArgs,
  ): string {
    const encodedArgs    = this._encodeExecutionArgs(args);
    const caveatsWithArgs = delegation.caveats.map((c, i) =>
      i === this.POLICY_ENFORCER_CAVEAT_INDEX ? { ...c, args: encodedArgs } : c,
    );
    const delegationWithArgs = { ...delegation, caveats: caveatsWithArgs };
    const permissionContext  = this._encodePermissionContext(delegationWithArgs);

    
    const batchCalldata = ethers.AbiCoder.defaultAbiCoder().encode(
      ['(address target, uint256 value, bytes callData)[]'],
      [executions.map(exec => {
        
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
    
    const encodedArgs = this._encodeExecutionArgs(args);
    const caveatsWithArgs = delegation.caveats.map((c, i) =>
      i === this.POLICY_ENFORCER_CAVEAT_INDEX
        ? { ...c, args: encodedArgs }
        : c
    );
    const delegationWithArgs = { ...delegation, caveats: caveatsWithArgs };

    
    const permissionContext = this._encodePermissionContext(delegationWithArgs);

    
    const executionCalldata = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [executionTarget, executionValue, ethers.getBytes(executionCd)],
    );

    
    return DM_IFACE.encodeFunctionData('redeemDelegations', [
      [permissionContext],          
      [MODE_SINGLE],                
      [executionCalldata],          
    ]);
  }

  
  private _encodeExecutionArgs(args: ExecutionArgs): string {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'uint256'],
      [args.preValueUSD6, args.postValueUSD6, args.feeAmountToken],
    );
  }

  
  private _encodePermissionContext(d: StoredDelegation): string {
    const caveats = d.caveats.map(c => ({
      enforcer: c.enforcer,
      terms:    c.terms,
      args:     c.args,
    }));

    
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

  

  
  encodeApproveToken(token: string, protocol: string, amount: bigint): string {
    return EXECUTOR_IFACE.encodeFunctionData('approveToken', [token, protocol, amount]);
  }

  get dmAddress(): string { return this.delegationManagerAddress; }
  get execAddress(): string { return this.executorAddress; }
}

export function depositArgs(portfolioValueUSD: number): ExecutionArgs {
  const usd6 = BigInt(Math.round(portfolioValueUSD * 1e6));
  return { preValueUSD6: usd6, postValueUSD6: usd6, feeAmountToken: 0n };
}

export function harvestArgs(params: {
  preValueUSD:  number;
  postValueUSD: number;
  maxFeeBps:    number;    
  feeTokenDecimals: number; 
}): ExecutionArgs {
  const { preValueUSD, postValueUSD, maxFeeBps, feeTokenDecimals } = params;
  const pre6  = BigInt(Math.round(preValueUSD  * 1e6));
  const post6 = BigInt(Math.round(postValueUSD * 1e6));

  let feeAmountToken = 0n;
  if (postValueUSD > preValueUSD) {
    const yieldUSD   = postValueUSD - preValueUSD;
    const feeUSD     = yieldUSD * (maxFeeBps / 10_000) * 0.99; 
    const feeFactor  = Math.pow(10, feeTokenDecimals) / 1e6;   
    feeAmountToken = BigInt(Math.floor(feeUSD * feeFactor * 1e6));
  }

  return { preValueUSD6: pre6, postValueUSD6: post6, feeAmountToken };
}

export function withdrawArgs(portfolioValueBeforeUSD: number): ExecutionArgs {
  const pre6 = BigInt(Math.round(portfolioValueBeforeUSD * 1e6));
  return { preValueUSD6: pre6, postValueUSD6: 0n, feeAmountToken: 0n };
}

export function rebalanceArgs(portfolioValueUSD: number): ExecutionArgs {
  return depositArgs(portfolioValueUSD);
}
