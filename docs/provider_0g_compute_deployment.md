## YieldGeko Provider on 0G Compute / Serving

This document is the production deployment checklist for the YieldGeko provider service on the `0G compute / serving` path.

### Goal

Deploy [packages/provider](/Users/seun/yieldsync/yieldgeko/packages/provider) as the real provider service that will:

- expose the public provider URL
- expose the attestation endpoint
- expose the quote verification endpoint
- produce registration metadata
- back YieldGeko's private execution trust boundary

### Required inputs

- `PROVIDER_PUBLIC_BASE_URL`
- `PROVIDER_DISPLAY_NAME`
- `PROVIDER_NETWORK`
- `PROVIDER_MODEL_ID`
- `PROVIDER_SERVICE_TYPE=chatbot`
- `PROVIDER_VERIFIABILITY=TeeML`
- `PROVIDER_INPUT_PRICE`
- `PROVIDER_OUTPUT_PRICE`
- `PROVIDER_SIGNING_PRIVATE_KEY`
- `PROVIDER_TEE_MRENCLAVE`
- `PROVIDER_TEE_INTEL_QUOTE_HEX`
- `PROVIDER_TEE_NVIDIA_PAYLOAD_JSON`

### Build artifact

The provider package includes a production container definition:

- [Dockerfile](/Users/seun/yieldsync/yieldgeko/packages/provider/Dockerfile)

Build command:

```bash
cd /Users/seun/yieldsync/yieldgeko/packages/provider
docker build -t yieldgeko-provider:latest .
```

### Startup contract

When the provider starts successfully, it writes:

- `.provider-metadata.json`
- `.provider-service.json`

These should be captured from the running provider environment and retained as deployment artifacts.

### Provider URL

The provider URL is exactly:

- `PROVIDER_PUBLIC_BASE_URL`

### Registration metadata

The generated `.provider-service.json` contains the core service-registration shape:

- `provider`
- `url`
- `serviceType`
- `model`
- `verifiability`
- `inputPrice`
- `outputPrice`

### Attestation fetch

After the provider is live on the 0G serving path, fetch attestation with:

```bash
cd /Users/seun/yieldsync/yieldgeko
pnpm attestation:fetch --provider-url https://your-provider-url --model your-model-id
```

### Truth boundary

This repo can prepare the deployment artifact and metadata contract.
The final missing pieces still come from the real 0G provider runtime:

- the actual public provider URL
- the actual attestation artifacts
- the actual registered provider identity in the serving environment
