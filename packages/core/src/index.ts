export const CHAIN_ID = 16602;
export const RPC_URL = "https://evmrpc-testnet.0g.ai";

export const ADDRESSES = {
  STRATEGY_REGISTRY: "0x1414F53fa0c67ec5BDb2d57747119f0185EE38A0",
  YIELD_GEKO_ROUTER: "0xc6534B399674293db43B4405e3669Eb71a1ca38C",
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
    { name: "asset", type: "address" },
    { name: "fromStrategy", type: "address" },
    { name: "toStrategy", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "minAPY", type: "uint256" },
    { name: "expectedAPY", type: "uint256" },
    { name: "maxSlippage", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
export * from './utils/encryption';
