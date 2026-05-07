# YieldGeko Provider Service

This package is the deployable provider-side service unit for YieldGeko's `0G compute / serving` path.

## Purpose

It exposes broker-compatible endpoints for:

- `GET /health`
- `GET /v1/quote`
- `POST /v1/quote/verify/gpu`
- `GET /v1/proxy/attestation/report?model=<model>`
- `POST /v1/proxy/chat/completions`
- `GET /v1/proxy/signature/:id`
- `POST /v1/proxy/route-plan`

The public base URL of this service becomes the provider URL after deployment into the 0G serving path.

## Production artifacts

This package now includes:

- `Dockerfile`
- `.env.example`
- generated `.provider-metadata.json`
- generated `.provider-service.json`

The two generated JSON files are the provider-side metadata outputs needed for service registration and attestation fetch workflows.

## Required environment

Use:

- `packages/provider/.env.example`

This package should be treated as a production deployment unit for 0G compute / serving, not as part of the root `pnpm dev` loop.
