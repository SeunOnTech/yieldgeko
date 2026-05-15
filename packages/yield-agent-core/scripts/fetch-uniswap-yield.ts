/**
 * UNISWAP V3 YIELD MONITOR USING FETCH
 *
 * FEATURES:
 * - Fetches live LP yields
 * - Monitors APR continuously
 * - Tracks TVL
 * - Tracks volume
 * - Cross-chain support
 * - No RPC needed
 * - No axios
 * - No env needed
 *
 * RUN:
 * npx ts-node monitor.ts
 */

type YieldPool = {
  chain: string
  project: string
  symbol: string

  tvlUsd: number

  apyBase?: number
  apyReward?: number
  apy?: number

  volumeUsd1d?: number

  rewardTokens?: string[]

  pool: string
}

type GeckoPool = {
  id: string

  attributes: {
    name: string

    address: string

    reserve_in_usd: string

    volume_usd: {
      h24: string
    }

    transactions: {
      h24: {
        buys: number
        sells: number
      }
    }
  }
}

// ======================================================
// CONFIG
// ======================================================

const REFRESH_INTERVAL = 30_000

// ======================================================
// FETCH HELPERS
// ======================================================

async function fetchJSON(url: string) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} - ${url}`,
    )
  }

  return response.json()
}

// ======================================================
// FETCH DEFI LLAMA YIELDS
// ======================================================

async function fetchYields(): Promise<
  YieldPool[]
> {
  const response = await fetchJSON(
    'https://yields.llama.fi/pools',
  )

  const data = response.data

  return data.filter((pool: YieldPool) => {
    return (
      pool.project &&
      pool.project
        .toLowerCase()
        .includes('uniswap')
    )
  })
}

// ======================================================
// FETCH GECKO TERMINAL POOLS
// ======================================================

async function fetchGeckoPools(
  network: string = 'eth',
): Promise<GeckoPool[]> {
  const response = await fetchJSON(
    `https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools`,
  )

  return response.data
}

// ======================================================
// HELPERS
// ======================================================

function formatUSD(value?: number) {
  if (!value) return '$0'

  return Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

function safe(value?: number) {
  return value ? value.toFixed(2) : '0.00'
}

// ======================================================
// SORT POOLS
// ======================================================

function rankPools(
  pools: YieldPool[],
): YieldPool[] {
  return pools.sort((a, b) => {
    const apyA = a.apy || 0
    const apyB = b.apy || 0

    return apyB - apyA
  })
}

// ======================================================
// DISPLAY YIELDS
// ======================================================

function renderPools(pools: YieldPool[]) {
  console.clear()

  console.log(
    '======================================================',
  )

  console.log(
    'UNISWAP V3 LIVE YIELD MONITOR',
  )

  console.log(
    `UPDATED: ${new Date().toLocaleString()}`,
  )

  console.log(
    '======================================================\n',
  )

  for (const pool of pools.slice(0, 25)) {
    console.log(
      `${pool.symbol} | ${pool.chain}`,
    )

    console.log(
      `Project: ${pool.project}`,
    )

    console.log(
      `TVL: ${formatUSD(pool.tvlUsd)}`,
    )

    console.log(
      `Base APY: ${safe(pool.apyBase)}%`,
    )

    console.log(
      `Reward APY: ${safe(
        pool.apyReward,
      )}%`,
    )

    console.log(
      `Total APY: ${safe(pool.apy)}%`,
    )

    console.log(
      `24h Volume: ${formatUSD(
        pool.volumeUsd1d,
      )}`,
    )

    if (
      pool.rewardTokens &&
      pool.rewardTokens.length > 0
    ) {
      console.log(
        `Reward Tokens: ${pool.rewardTokens.join(
          ', ',
        )}`,
      )
    }

    console.log(
      `Pool ID: ${pool.pool}`,
    )

    console.log(
      '------------------------------------------------------\n',
    )
  }
}

// ======================================================
// DISPLAY TRENDING POOLS
// ======================================================

function renderTrendingPools(
  pools: GeckoPool[],
) {
  console.log(
    '\n======================================================',
  )

  console.log(
    'TRENDING POOLS',
  )

  console.log(
    '======================================================\n',
  )

  for (const pool of pools.slice(0, 10)) {
    const attr = pool.attributes

    console.log(attr.name)

    console.log(
      `Liquidity: ${formatUSD(
        Number(attr.reserve_in_usd),
      )}`,
    )

    console.log(
      `24h Volume: ${formatUSD(
        Number(attr.volume_usd.h24),
      )}`,
    )

    console.log(
      `Buys: ${attr.transactions.h24.buys}`,
    )

    console.log(
      `Sells: ${attr.transactions.h24.sells}`,
    )

    console.log(
      '------------------------------------------------------\n',
    )
  }
}

// ======================================================
// MAIN
// ======================================================

async function run() {
  try {
    const yields = await fetchYields()

    const ranked = rankPools(yields)

    renderPools(ranked)

    try {
      const gecko =
        await fetchGeckoPools('eth')

      renderTrendingPools(gecko)
    } catch (err) {
      console.error(
        'GeckoTerminal fetch failed',
      )
    }
  } catch (err) {
    console.error(
      'Yield fetch failed',
      err,
    )
  }
}

// ======================================================
// START
// ======================================================

run()

setInterval(run, REFRESH_INTERVAL)