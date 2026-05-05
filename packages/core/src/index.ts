export const CHAIN_ID = 16602;
export const RPC_URL = "https://evmrpc-testnet.0g.ai";

export const ADDRESSES = {
  STRATEGY_REGISTRY: "0x29061B4af1750cBa1412CA37Fe747e768189d7C0",
  YIELD_GEKO_ROUTER: "0xf1C15C14036256c82dF73f0f8a36a3E225F6f22f",
  TREASURY: "0x092106703adE19BF7a638AD371f8f6c25831F349",
  AGENT: "0x092106703adE19BF7a638AD371f8f6c25831F349"
} as const;

export const EIP712_DOMAIN = {
  name: "YieldGeko",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: ADDRESSES.YIELD_GEKO_ROUTER
} as const;

export const INTENT_TYPES = {
  Intent: [
    { name: "user", type: "address" },
    { name: "minAPY", type: "uint256" },
    { name: "maxSlippage", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
