throw new Error(
  [
    'contracts/scripts/deploy.ts is intentionally disabled.',
    'Use the production Foundry deploy script instead:',
    '  forge script script/Deploy.s.sol --rpc-url <RPC_URL> --broadcast -vvvv',
    'This prevents accidentally deploying the removed Router/Registry architecture.',
  ].join('\n'),
);
