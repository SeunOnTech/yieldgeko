# YieldGeko Provider Requirements

## Must-have inputs before real deployment

- provider signing private key
- public base URL / domain for the provider service
- target network choice (`0G testnet` first recommended)
- real TEE attestation artifacts:
  - MRENCLAVE
  - intel quote / attestation report
  - NVIDIA payload if applicable to the deployment stack
- 0G compute / serving deployment target

## Outputs produced by the provider package

When `packages/provider` starts successfully, it produces:

- provider address
- provider public key coordinates
- provider metadata file
- attestation endpoint path
- quote endpoint path

## What this unlocks

Once deployed publicly, we can use:

- `scripts/fetch-tee-attestation.ts`

with the real provider URL and model to normalize the attestation payload for the agent runtime.
