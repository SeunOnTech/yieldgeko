# YieldGeko 0G TEE Attestation Runbook

This runbook exists to get YieldGeko from placeholder TEE config to real production attestation inputs.

## What we need

The agent requires two production attestation values:

- `ZERO_G_TEE_MRENCLAVE`
- `ZERO_G_TEE_RA_REPORT`

These are not static constants. They come from a real deployed TEE-backed service.

## Current repo truth

YieldGeko now treats attestation in two modes:

- `AGENT_ENVIRONMENT=production`
  - requires real attestation values
- `AGENT_ENVIRONMENT=development`
  - can allow unattested mode only if explicitly enabled

Production mode is now fail-closed.

## Where real attestation data comes from

In the installed 0G serving broker stack, provider verification pulls attestation data from provider endpoints such as:

- `/v1/proxy/attestation/report?model=<model>`
- `/v1/quote`
- `/v1/quote/verify/gpu`

The broker code also expects fields such as:

- `signing_address`
- `nvidia_payload`
- `intel_quote`

Those shapes come from the installed package in this repo:

- `frontend/node_modules/@0glabs/0g-serving-broker/.../inference/broker/verifier.js`
- `frontend/node_modules/@0glabs/0g-serving-broker/.../types/inference/broker/verifier.d.ts`

## What this means operationally

Before YieldGeko can run in real production-attested mode, we must have a real 0G TEE-backed provider/service.

That provider must give us at least:

- a provider URL
- a model identifier
- an attestation report endpoint response

## Minimal path to real values

### 1. Stand up a real 0G-backed provider service

This is the missing infrastructure step today.

We need a running service that exposes the serving-broker-compatible endpoints.
The installed broker package includes example server tooling that can be adapted into a real provider workflow.

Relevant local references:

- `frontend/node_modules/@0glabs/0g-serving-broker/cli.commonjs/example/inference-server.js`
- `frontend/node_modules/@0glabs/0g-serving-broker/cli.commonjs/cli/inference.js`

### 2. Obtain the provider URL and model

Once the service is deployed, capture:

- `providerUrl`
- `model`

Example shape:

- `providerUrl=https://your-provider.example.com`
- `model=yieldgeko-agent-v1`

### 3. Fetch the provider attestation report

Use the helper script in this repo:

```bash
cd yieldgeko
pnpm --dir packages/agent exec ts-node ../scripts/fetch-tee-attestation.ts \
  --provider-url https://your-provider.example.com \
  --model yieldgeko-agent-v1 \
  --output tee-attestation.json
```

This script calls:

```text
GET <providerUrl>/v1/proxy/attestation/report?model=<model>
```

and normalizes:

- `zeroGTeeRaReport`
- `zeroGTeeMrenclave` if the provider exposes it directly

### 4. Fill the agent env

If the provider response exposes both values, copy them into:

- `packages/agent/.env.local` for local verification, or
- your production secret manager for deployment

```env
AGENT_ENVIRONMENT=production
ZERO_G_TEE_MRENCLAVE=0x...
ZERO_G_TEE_RA_REPORT=0x...  # or the normalized report string expected by our runtime
```

## Important limitation

The broker/provider attestation response commonly exposes `intel_quote`, but it may not expose `mrenclave` directly.

If that happens, you still need the enclave measurement from the real TEE deployment workflow itself.

That measurement normally comes from one of:

- the TEE launcher output
- enclave build metadata
- provider-side attestation export
- a quote parsing/verification pipeline

## Current recommended next build step

YieldGeko still needs a dedicated provider deployment unit for the agent itself.

The production direction should be:

1. package the YieldGeko agent as a real 0G TEE-backed service
2. expose broker-compatible attestation/report endpoints
3. capture attestation with the script above
4. add cryptographic verification of the returned report inside the agent runtime

## Current repo helper

A standalone capture tool now exists at:

- `scripts/fetch-tee-attestation.ts`

It is intentionally standalone and not wired into backend startup.
