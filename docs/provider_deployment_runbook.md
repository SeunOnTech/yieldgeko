# YieldGeko Provider Deployment Runbook

This runbook covers the provider-side deployment path required to obtain a real provider URL for YieldGeko on the `0G compute / serving` path.

## Goal

Stand up a broker-compatible YieldGeko provider service so we can obtain:

- a real provider URL
- a provider address
- service metadata (`model`, `verifiability`, endpoint)
- real attestation/report fetch path

## What the provider service does

The provider package lives at:

- `packages/provider`

It exposes:

- `GET /health`
- `GET /v1/quote`
- `POST /v1/quote/verify/gpu`
- `GET /v1/proxy/attestation/report?model=<model>`
- `POST /v1/proxy/chat/completions`
- `GET /v1/proxy/signature/:id`
- `POST /v1/proxy/route-plan`

## Local startup

```bash
cd yieldgeko
pnpm --dir packages/provider start
```

On startup it writes:

- `.provider-metadata.json`

inside `packages/provider/`

That file contains:

- `providerAddress`
- `providerPubKey`
- `publicBaseUrl`
- `model`
- `verifiability`
- attestation endpoint URL
- quote endpoint URL

## Required provider env

For production-style configuration:

- `PROVIDER_PUBLIC_BASE_URL`
- `PROVIDER_MODEL_ID`
- `PROVIDER_SIGNING_PRIVATE_KEY`
- `PROVIDER_TEE_MRENCLAVE`
- `PROVIDER_TEE_INTEL_QUOTE_HEX`
- `PROVIDER_TEE_NVIDIA_PAYLOAD_JSON`

## How the provider URL is obtained

The provider URL is simply:

- `PROVIDER_PUBLIC_BASE_URL`

Examples:

- `https://yieldgeko-tee.example.com`
- `https://provider.yieldgeko.com`

Once the service is deployed publicly, that URL becomes the provider URL used by:

- service registration metadata
- attestation fetch tooling
- future broker-based routing

## What still must happen outside this repo

This scaffold makes the provider deployable, but the following still require real infrastructure and credentials:

1. choose the actual `0G compute / serving` runtime target
2. deploy the service publicly into that runtime
3. set a real `PROVIDER_PUBLIC_BASE_URL`
4. register/publish the provider metadata in the 0G serving path
5. fetch attestation with `scripts/fetch-tee-attestation.ts`

## Production recommendation

Use this package first on 0G testnet as the provider-side service unit for the serving path.
Only move to mainnet after:

- provider URL is stable
- attestation report is fetchable
- quote verification path is tested
- route-plan signing and signature retrieval are validated end-to-end
