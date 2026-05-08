## 0G Galileo Deployment (Testnet — NOT for hackathon submission)

Date: `2026-05-06`
Network: `0G Galileo Testnet`
Chain ID: `16602`
RPC: `https://evmrpc-testnet.0g.ai`
Explorer: `https://chainscan-galileo.0g.ai`

### Contracts

- `StrategyRegistry`: `0x1414F53fa0c67ec5BDb2d57747119f0185EE38A0`
- `YieldGekoRouter`: `0xc6534B399674293db43B4405e3669Eb71a1ca38C`
- `Treasury`: `0x092106703adE19BF7a638AD371f8f6c25831F349`
- `Authorized Agent`: `0x092106703adE19BF7a638AD371f8f6c25831F349`
- `Owner / Deployer`: `0x092106703adE19BF7a638AD371f8f6c25831F349`

### Transactions

- `StrategyRegistry deploy`: `0x8139969306b63a37458463d4ea10733b28048a4235bc7dfc81f746c0141a975e`
- `YieldGekoRouter deploy`: `0x0a24bf19cd35a377b91ef7137dacee76be219d8c92ba9bec7bec23dffbae95bf`

### On-Chain Verification Checks

- `StrategyRegistry.owner()` -> `0x092106703adE19BF7a638AD371f8f6c25831F349`
- `YieldGekoRouter.owner()` -> `0x092106703adE19BF7a638AD371f8f6c25831F349`
- `YieldGekoRouter.authorizedAgent()` -> `0x092106703adE19BF7a638AD371f8f6c25831F349`
- `YieldGekoRouter.treasury()` -> `0x092106703adE19BF7a638AD371f8f6c25831F349`
- `YieldGekoRouter.registry()` -> `0x1414F53fa0c67ec5BDb2d57747119f0185EE38A0`

---

## Arbitrum Mainnet Deployment (YieldGekoVault — holds user funds)

**Status: PENDING — needs ARB ETH for gas**

Network: `Arbitrum One`
Chain ID: `42161`
RPC: `https://arb1.arbitrum.io/rpc`
Explorer: `https://arbiscan.io`

### Deploy Command

```bash
export ARB_RPC_URL="https://arb1.arbitrum.io/rpc"
export PRIVATE_KEY="<deployer-private-key>"
export AGENT_ADDR="<agent-wallet-address>"
export TREASURY_ADDR="<treasury-address>"

forge create --broadcast --legacy \
  --rpc-url "$ARB_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  contracts/YieldGekoVault.sol:YieldGekoVault \
  --constructor-args "$AGENT_ADDR" "$TREASURY_ADDR"
```

### Deploy same vault on any additional chain (Base, Optimism, etc.)

```bash
# Same command, just change RPC_URL and chain-specific gas price
forge create --broadcast --legacy \
  --rpc-url "$BASE_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  contracts/YieldGekoVault.sol:YieldGekoVault \
  --constructor-args "$AGENT_ADDR" "$TREASURY_ADDR"
```

### Contracts (fill after deploy)

- `YieldGekoVault` (Arbitrum): `TBD`
- Explorer: `https://arbiscan.io/address/TBD`

---

## 0G Mainnet Deployment (Required for hackathon submission)

**Status: PENDING — needs real 0G tokens for gas**

Network: `0G Mainnet`
Chain ID: `16661`
RPC: `https://evmrpc.0g.ai`
Explorer: `https://chainscan.0g.ai`

### Deploy Commands

```bash
# Set env vars
export RPC_URL="https://evmrpc.0g.ai"
export PRIVATE_KEY="<your-private-key>"
export AGENT_ADDR="<your-agent-address>"
export TREASURY_ADDR="<your-treasury-address>"

# Step 1: Deploy StrategyRegistry
forge create --broadcast --legacy \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --gas-price 2gwei \
  contracts/StrategyRegistry.sol:StrategyRegistry

# Copy the deployed address above, then:
export REGISTRY_ADDR="<deployed-StrategyRegistry-address>"

# Step 2: Deploy YieldGekoRouter
forge create --broadcast --legacy \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --gas-price 2gwei \
  contracts/YieldGekoRouter.sol:YieldGekoRouter \
  --constructor-args "$REGISTRY_ADDR" "$AGENT_ADDR" "$TREASURY_ADDR"
```

### Post-Deploy Verification

```bash
# Verify on-chain state
cast call <ROUTER_ADDR> "owner()(address)" --rpc-url "$RPC_URL"
cast call <ROUTER_ADDR> "authorizedAgent()(address)" --rpc-url "$RPC_URL"
cast call <ROUTER_ADDR> "registry()(address)" --rpc-url "$RPC_URL"
```

### Contracts (fill after deploy)

- `StrategyRegistry`: `TBD`
- `YieldGekoRouter`: `TBD`
- `Treasury`: `$TREASURY_ADDR`
- Explorer: `https://chainscan.0g.ai/address/TBD`

---

### Broadcast Commands (legacy — Galileo format)

```bash
forge create --broadcast --legacy --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" --gas-price 3gwei contracts/StrategyRegistry.sol:StrategyRegistry

forge create --broadcast --legacy --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" --gas-price 3gwei contracts/YieldGekoRouter.sol:YieldGekoRouter --constructor-args 0x1414F53fa0c67ec5BDb2d57747119f0185EE38A0 "$AGENT_ADDR" "$TREASURY_ADDR"
```
