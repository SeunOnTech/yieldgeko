## Strategy Registry Onboarding

This registry is part of the production control plane. Do not hand-craft calldata against the live registry.

### Preconditions

- the target strategy contract is already deployed on its target chain
- the adapter contract is already deployed and audited
- both addresses have bytecode on the network where the registry lives
- the registry owner wallet is the signer used for registration
- the strategy metadata has been reviewed for:
  - target chain ID
  - minimum liquidity floor
  - audit status

### Important schema note

The registry stores `chainId` as `uint64`, not `uint8`.
This is required for real EVM chain IDs like:

- `42161` for Arbitrum
- `8453` for Base
- `10` for Optimism

### Example manifest

Use [strategies.galileo.example.json](/Users/seun/yieldsync/yieldgeko/contracts/strategies.galileo.example.json) as the template.

### Registration command

```bash
cd /Users/seun/yieldsync/yieldgeko/contracts
STRATEGY_MANIFEST_PATH=./strategies.galileo.example.json pnpm exec hardhat run --network zeroGGaleleo scripts/register-strategies.ts
```

### Safety behavior

The registration script will:

- fail if the registry has no code
- fail if the connected signer is not the registry owner
- fail if the strategy address has no code
- fail if the adapter address has no code
- skip entries already registered with exactly matching metadata
- fail if an active entry exists with conflicting metadata

### Current blocker to real onboarding

The repo currently contains only a test adapter:

- [MockStrategyAdapter.sol](/Users/seun/yieldsync/yieldgeko/contracts/contracts/test/MockStrategyAdapter.sol)

That adapter is not production-safe and must not be registered in the live registry.
Real strategy onboarding should begin only after audited production adapters exist for the target opportunity classes.
