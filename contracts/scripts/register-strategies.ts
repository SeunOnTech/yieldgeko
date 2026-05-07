import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { network } from "hardhat";
import { getAddress, isAddress, type Address } from "viem";
import { loadContractEnv } from "./lib/load-env.js";

loadContractEnv();

type StrategyManifestEntry = {
  strategy: string;
  adapter: string;
  name: string;
  chainId: number;
  minLiquidity: string | number;
  isAudited: boolean;
};

type StrategyManifest = {
  registry?: string;
  strategies: StrategyManifestEntry[];
};

const strategyRegistryAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getStrategyInfo",
    stateMutability: "view",
    inputs: [{ name: "_strategy", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "isActive", type: "bool" },
          { name: "adapter", type: "address" },
          { name: "name", type: "string" },
          { name: "chainId", type: "uint64" },
          { name: "minLiquidity", type: "uint256" },
          { name: "isAudited", type: "bool" },
          { name: "isPaused", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "addStrategy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_strategy", type: "address" },
      { name: "_adapter", type: "address" },
      { name: "_name", type: "string" },
      { name: "_chainId", type: "uint64" },
      { name: "_minLiquidity", type: "uint256" },
      { name: "_isAudited", type: "bool" },
    ],
    outputs: [],
  },
] as const;

function resolveManifestPath(): string {
  const manifestPath = process.env.STRATEGY_MANIFEST_PATH;
  if (!manifestPath || manifestPath.trim().length === 0) {
    throw new Error("STRATEGY_MANIFEST_PATH is required");
  }

  return resolve(process.cwd(), manifestPath);
}

function requireRegistryAddress(manifest: StrategyManifest): Address {
  const raw = manifest.registry ?? process.env.STRATEGY_REGISTRY_ADDR;
  if (!raw || raw.trim().length === 0) {
    throw new Error("STRATEGY_REGISTRY_ADDR is required either in the manifest or contracts/.env");
  }

  if (!isAddress(raw)) {
    throw new Error(`Invalid registry address: ${raw}`);
  }

  return getAddress(raw);
}

function parseManifest(path: string): StrategyManifest {
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw) as StrategyManifest;

  if (!Array.isArray(manifest.strategies) || manifest.strategies.length === 0) {
    throw new Error("Manifest must include a non-empty strategies array");
  }

  return manifest;
}

function normalizeAddress(value: string, label: string): Address {
  if (!isAddress(value)) {
    throw new Error(`${label} must be a valid address`);
  }

  return getAddress(value);
}

function normalizeChainId(value: number): bigint {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`chainId must be a positive integer, received ${value}`);
  }

  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`chainId is too large for safe manifest parsing: ${value}`);
  }

  return BigInt(value);
}

function normalizeMinLiquidity(value: string | number): bigint {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`minLiquidity must be a non-negative integer, received ${value}`);
    }

    return BigInt(value);
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`minLiquidity string must be an integer, received ${value}`);
  }

  return BigInt(value);
}

async function assertContractCode(publicClient: { getCode(args: { address: Address }): Promise<`0x${string}` | undefined> }, address: Address, label: string) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") {
    throw new Error(`${label} ${address} has no deployed bytecode on the target network`);
  }
}

async function main() {
  const manifestPath = resolveManifestPath();
  const manifest = parseManifest(manifestPath);
  const registryAddress = requireRegistryAddress(manifest);
  const { viem } = await network.connect();

  const publicClient = await viem.getPublicClient();
  const [walletClient] = await viem.getWalletClients();
  if (!walletClient) {
    throw new Error("No wallet client available for strategy registration");
  }

  await assertContractCode(publicClient, registryAddress, "Registry");

  const owner = await publicClient.readContract({
    address: registryAddress,
    abi: strategyRegistryAbi,
    functionName: "owner",
  });

  if (getAddress(owner) !== getAddress(walletClient.account.address)) {
    throw new Error(
      `Connected deployer ${walletClient.account.address} is not registry owner ${owner}. Refusing to mutate live registry.`
    );
  }

  for (const [index, entry] of manifest.strategies.entries()) {
    const strategy = normalizeAddress(entry.strategy, `strategies[${index}].strategy`);
    const adapter = normalizeAddress(entry.adapter, `strategies[${index}].adapter`);
    const chainId = normalizeChainId(entry.chainId);
    const minLiquidity = normalizeMinLiquidity(entry.minLiquidity);

    if (entry.name.trim().length === 0) {
      throw new Error(`strategies[${index}].name must not be empty`);
    }

    await assertContractCode(publicClient, strategy, `Strategy`);
    await assertContractCode(publicClient, adapter, `Adapter`);

    const current = await publicClient.readContract({
      address: registryAddress,
      abi: strategyRegistryAbi,
      functionName: "getStrategyInfo",
      args: [strategy],
    });

    if (current.isActive) {
      const matches =
        getAddress(current.adapter) === adapter &&
        current.name === entry.name &&
        current.chainId === chainId &&
        current.minLiquidity === minLiquidity &&
        current.isAudited === entry.isAudited &&
        current.isPaused === false;

      if (!matches) {
        throw new Error(
          `Strategy ${strategy} is already active with different metadata. Refusing to overwrite live registry state.`
        );
      }

      console.log(`Skipping ${entry.name} (${strategy}) - already registered with matching metadata`);
      continue;
    }

    console.log(`Registering ${entry.name} (${strategy}) via adapter ${adapter}`);
    const hash = await walletClient.writeContract({
      address: registryAddress,
      abi: strategyRegistryAbi,
      functionName: "addStrategy",
      args: [strategy, adapter, entry.name, chainId, minLiquidity, entry.isAudited],
      chain: walletClient.chain,
      account: walletClient.account,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Strategy registration failed for ${entry.name}: ${hash}`);
    }

    console.log(`Registered ${entry.name}: ${hash}`);
  }

  console.log("Strategy manifest applied successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
