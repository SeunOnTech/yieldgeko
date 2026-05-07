## 0G Galileo Deployment

Date: `2026-05-06`
Network: `0G Galileo Testnet`
Chain ID: `16602`
RPC: `https://evmrpc-testnet.0g.ai`

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

### Broadcast Commands

```bash
forge create --broadcast --legacy --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" --gas-price 3gwei contracts/StrategyRegistry.sol:StrategyRegistry

forge create --broadcast --legacy --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" --gas-price 3gwei contracts/YieldGekoRouter.sol:YieldGekoRouter --constructor-args 0x1414F53fa0c67ec5BDb2d57747119f0185EE38A0 "$AGENT_ADDR" "$TREASURY_ADDR"
```
