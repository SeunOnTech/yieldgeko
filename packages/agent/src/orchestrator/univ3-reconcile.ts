import { ethers, type JsonRpcProvider } from 'ethers';

import type { ExecutionRecord, PortfolioPosition } from './types';

const POS_MGR = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const TOPIC_INCREASE_LIQUIDITY = ethers.id('IncreaseLiquidity(uint256,uint128,uint256,uint256)');
const TOPIC_TRANSFER = ethers.id('Transfer(address,address,uint256)');

const POS_MGR_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  `function positions(uint256 tokenId) view returns (
    uint96 nonce,
    address operator,
    address token0,
    address token1,
    uint24 fee,
    int24 tickLower,
    int24 tickUpper,
    uint128 liquidity,
    uint256 feeGrowthInside0LastX128,
    uint256 feeGrowthInside1LastX128,
    uint128 tokensOwed0,
    uint128 tokensOwed1
  )`,
];

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

export interface UniV3ReconciliationResult {
  status: 'reconciled' | 'ambiguous' | 'unresolved';
  positionPatch?: Partial<PortfolioPosition>;
  tokenId?: string;
  liquidity?: string;
  source?: 'stored' | 'receipt' | 'owner-scan';
  matchedTxHash?: string;
  detail: string;
}

interface Candidate {
  tokenId: bigint;
  source: 'stored' | 'receipt' | 'owner-scan';
  txHash?: string;
}

interface ValidatedCandidate {
  tokenId: bigint;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  token0: string;
  token1: string;
  fee: number;
  source: Candidate['source'];
  txHash?: string;
}

export interface UniV3MintProvenance {
  tokenId: string;
  txHash: string;
  blockNumber: number;
  blockTimestamp: number;
}

function normalizeAddress(value: string | undefined): string | null {
  if (!value) return null;
  return value.toLowerCase();
}

function parseUniV3MintTokenIds(receipt: ethers.TransactionReceipt): bigint[] {
  const tokenIds: bigint[] = [];
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === POS_MGR.toLowerCase()
      && log.topics[0] === TOPIC_INCREASE_LIQUIDITY
      && log.topics[1]
    ) {
      tokenIds.push(BigInt(log.topics[1]));
    }
  }
  return tokenIds;
}

async function validateCandidate(
  provider: JsonRpcProvider,
  smartAccountAddress: string,
  expectedPoolAddress: string,
  position: PortfolioPosition,
  candidate: Candidate,
): Promise<ValidatedCandidate | null> {
  const posMgr = new ethers.Contract(POS_MGR, POS_MGR_ABI, provider);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);

  try {
    const [owner, rawPos] = await Promise.all([
      posMgr.ownerOf(candidate.tokenId) as Promise<string>,
      posMgr.positions(candidate.tokenId),
    ]);

    if (owner.toLowerCase() !== smartAccountAddress.toLowerCase()) return null;

    const token0 = rawPos.token0 as string;
    const token1 = rawPos.token1 as string;
    const fee = Number(rawPos.fee);
    const tickLower = Number(rawPos.tickLower);
    const tickUpper = Number(rawPos.tickUpper);
    const liquidity = BigInt(rawPos.liquidity);
    const poolAddress = (await factory.getPool(token0, token1, fee) as string).toLowerCase();

    if (poolAddress !== expectedPoolAddress.toLowerCase()) return null;

    if (position.uniV3Token0 && normalizeAddress(position.uniV3Token0) !== normalizeAddress(token0)) return null;
    if (position.uniV3Token1 && normalizeAddress(position.uniV3Token1) !== normalizeAddress(token1)) return null;

    return {
      tokenId: candidate.tokenId,
      liquidity,
      tickLower,
      tickUpper,
      token0,
      token1,
      fee,
      source: candidate.source,
      txHash: candidate.txHash,
    };
  } catch {
    return null;
  }
}

async function findReceiptCandidates(
  provider: JsonRpcProvider,
  txHashes: string[],
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  for (const txHash of txHashes) {
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) continue;
      for (const tokenId of parseUniV3MintTokenIds(receipt)) {
        candidates.push({ tokenId, source: 'receipt', txHash });
      }
    } catch {
      
    }
  }

  return candidates;
}

async function findOwnerScanCandidates(
  provider: JsonRpcProvider,
  smartAccountAddress: string,
): Promise<Candidate[]> {
  const posMgr = new ethers.Contract(POS_MGR, POS_MGR_ABI, provider);

  try {
    const count = Number(await posMgr.balanceOf(smartAccountAddress));
    const capped = Math.min(count, 64);
    const ids = await Promise.all(
      Array.from({ length: capped }, async (_, index) =>
        posMgr.tokenOfOwnerByIndex(smartAccountAddress, BigInt(index)) as Promise<bigint>,
      ),
    );

    return ids.map(tokenId => ({ tokenId: BigInt(tokenId), source: 'owner-scan' as const }));
  } catch {
    return [];
  }
}

export async function findUniV3MintProvenance(params: {
  provider: JsonRpcProvider;
  smartAccountAddress: string;
  tokenId: bigint | string;
}): Promise<UniV3MintProvenance | null> {
  const { provider, smartAccountAddress, tokenId } = params;
  const paddedOwner = ethers.zeroPadValue(smartAccountAddress, 32);
  const paddedZero = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  const paddedTokenId = ethers.toBeHex(BigInt(tokenId), 32);

  try {
    const logs = await provider.getLogs({
      address: POS_MGR,
      topics: [TOPIC_TRANSFER, paddedZero, paddedOwner, paddedTokenId],
      fromBlock: 0,
      toBlock: 'latest',
    });
    const log = logs.at(-1);
    if (!log) return null;

    const block = await provider.getBlock(log.blockNumber);
    if (!block) return null;

    return {
      tokenId: BigInt(tokenId).toString(),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      blockTimestamp: block.timestamp,
    };
  } catch {
    return null;
  }
}

export async function reconcileUniV3Position(params: {
  provider: JsonRpcProvider;
  strategyId: string;
  smartAccountAddress?: string;
  position: PortfolioPosition;
  executions?: ExecutionRecord[];
  candidateTxHash?: string;
  candidateTokenId?: bigint | string;
}): Promise<UniV3ReconciliationResult> {
  const {
    provider,
    smartAccountAddress,
    position,
    executions = [],
    candidateTxHash,
    candidateTokenId,
  } = params;

  if (!smartAccountAddress || !position.uniV3EntryPool) {
    return {
      status: 'unresolved',
      detail: 'Missing smart-account address or UniV3 entry pool for reconciliation',
    };
  }

  const directCandidates: Candidate[] = [];
  const seen = new Set<string>();

  const addCandidate = (candidate: Candidate) => {
    const key = `${candidate.source}:${candidate.txHash ?? ''}:${candidate.tokenId.toString()}`;
    if (seen.has(key)) return;
    seen.add(key);
    directCandidates.push(candidate);
  };

  if (candidateTokenId != null) {
    addCandidate({ tokenId: BigInt(candidateTokenId), source: 'receipt', txHash: candidateTxHash });
  }

  if (position.uniV3TokenId) {
    addCandidate({ tokenId: BigInt(position.uniV3TokenId), source: 'stored' });
  }

  const relevantExecutions = executions
    .filter(exec =>
      (exec.action === 'GENESIS' || exec.action === 'REBALANCE_UNIV3')
      && !!exec.txHash
      && (
        !exec.positionId
        || exec.positionId === position.id
        || exec.replacedPositionId === position.id
      ),
    )
    .sort((left, right) => right.timestamp - left.timestamp);

  const receiptTxHashes = Array.from(new Set([
    candidateTxHash,
    ...relevantExecutions.map(exec => exec.txHash),
  ].filter((value): value is string => !!value)));

  for (const candidate of await findReceiptCandidates(provider, receiptTxHashes)) addCandidate(candidate);
  for (const candidate of await findOwnerScanCandidates(provider, smartAccountAddress)) addCandidate(candidate);

  const validated: ValidatedCandidate[] = [];
  for (const candidate of directCandidates) {
    const match = await validateCandidate(
      provider,
      smartAccountAddress,
      position.uniV3EntryPool,
      position,
      candidate,
    );
    if (!match) continue;

    const duplicate = validated.some(existing => existing.tokenId === match.tokenId);
    if (!duplicate) validated.push(match);
  }

  const liveMatches = validated.filter(candidate => candidate.liquidity > 0n);
  const storedLive = liveMatches.find(candidate => candidate.source === 'stored');
  const receiptLive = liveMatches.find(candidate => candidate.source === 'receipt');

  let selected: ValidatedCandidate | undefined;
  if (receiptLive) {
    selected = receiptLive;
  } else if (storedLive) {
    selected = storedLive;
  } else if (liveMatches.length === 1) {
    selected = liveMatches[0];
  }

  if (!selected && liveMatches.length > 1) {
    return {
      status: 'ambiguous',
      detail: `Multiple live UniV3 candidates found for strategy ${params.strategyId}; refusing auto-attachment`,
    };
  }

  const fallback = validated.find(candidate => position.uniV3TokenId && candidate.tokenId.toString() === position.uniV3TokenId);
  if (!selected && fallback) selected = fallback;

  if (!selected) {
    return {
      status: 'unresolved',
      detail: `No valid UniV3 candidate found for strategy ${params.strategyId}`,
    };
  }

  return {
    status: 'reconciled',
    tokenId: selected.tokenId.toString(),
    liquidity: selected.liquidity.toString(),
    source: selected.source,
    matchedTxHash: selected.txHash,
    detail: `Resolved active UniV3 NFT ${selected.tokenId.toString()} via ${selected.source}`,
    positionPatch: {
      uniV3TokenId: selected.tokenId.toString(),
      uniV3Liquidity: selected.liquidity.toString(),
      uniV3TickLower: selected.tickLower,
      uniV3TickUpper: selected.tickUpper,
      uniV3CenterTick: Math.floor((selected.tickLower + selected.tickUpper) / 2),
      uniV3Token0: selected.token0,
      uniV3Token1: selected.token1,
      uniV3LastDriftPct: 0,
    },
  };
}
