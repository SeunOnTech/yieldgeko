import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Inputs = {
  providerUrl: string;
  model: string;
  output?: string;
};

type RawAttestationResponse = {
  signing_address?: string;
  nvidia_payload?: unknown;
  intel_quote?: string;
  mrenclave?: string;
  mr_enclave?: string;
  [key: string]: unknown;
};

type NormalizedAttestation = {
  fetchedAt: string;
  providerUrl: string;
  model: string;
  signingAddress: string | null;
  zeroGTeeRaReport: string;
  zeroGTeeMrenclave: string | null;
  mrenclaveSource: 'provider-response' | 'derived-from-report' | 'unavailable';
  raw: RawAttestationResponse;
};

function usage(): never {
  console.error(
    'Usage: pnpm exec ts-node scripts/fetch-tee-attestation.ts --provider-url <url> --model <model> [--output <file>]'
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Inputs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      usage();
    }
    args.set(key, value);
    i += 1;
  }

  const providerUrl = args.get('--provider-url');
  const model = args.get('--model');
  const output = args.get('--output');

  if (!providerUrl || !model) {
    usage();
  }

  return { providerUrl, model, output };
}

function normalizeProviderUrl(input: string): string {
  const url = new URL(input);
  return url.toString().replace(/\/$/, '');
}

function decodeBase64ToHex(input: string): string {
  return `0x${Buffer.from(input, 'base64').toString('hex')}`;
}

function looksLikeHex32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function extractMrenclave(raw: RawAttestationResponse): {
  value: string | null;
  source: NormalizedAttestation['mrenclaveSource'];
} {
  const direct = typeof raw.mrenclave === 'string'
    ? raw.mrenclave
    : typeof raw.mr_enclave === 'string'
      ? raw.mr_enclave
      : null;

  if (direct && looksLikeHex32(direct)) {
    return { value: direct, source: 'provider-response' };
  }

  return { value: null, source: 'unavailable' };
}

async function fetchAttestation(inputs: Inputs): Promise<NormalizedAttestation> {
  const providerUrl = normalizeProviderUrl(inputs.providerUrl);
  const url = `${providerUrl}/v1/proxy/attestation/report?model=${encodeURIComponent(inputs.model)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Attestation endpoint failed (${response.status}): ${body}`);
  }

  const raw = (await response.json()) as RawAttestationResponse;

  let zeroGTeeRaReport = '';
  if (typeof raw.intel_quote === 'string' && raw.intel_quote.length > 0) {
    zeroGTeeRaReport = raw.intel_quote.startsWith('0x')
      ? raw.intel_quote
      : decodeBase64ToHex(raw.intel_quote);
  } else {
    zeroGTeeRaReport = JSON.stringify(raw);
  }

  const mrenclave = extractMrenclave(raw);

  return {
    fetchedAt: new Date().toISOString(),
    providerUrl,
    model: inputs.model,
    signingAddress: typeof raw.signing_address === 'string' ? raw.signing_address : null,
    zeroGTeeRaReport,
    zeroGTeeMrenclave: mrenclave.value,
    mrenclaveSource: mrenclave.source,
    raw,
  };
}

async function main() {
  const inputs = parseArgs(process.argv.slice(2));
  const result = await fetchAttestation(inputs);
  const serialized = JSON.stringify(result, null, 2);

  if (inputs.output) {
    const outputPath = resolve(process.cwd(), inputs.output);
    writeFileSync(outputPath, `${serialized}\n`, 'utf8');
    console.log(`Attestation written to ${outputPath}`);
  } else {
    console.log(serialized);
  }

  if (!result.zeroGTeeMrenclave) {
    console.warn(
      'MRENCLAVE was not exposed by the provider response. You still need the enclave measurement from your TEE deployment or provider attestation workflow.'
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
