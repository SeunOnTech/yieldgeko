import { getAddress, isAddress } from "viem";
import { network } from "hardhat";
import { loadContractEnv } from "./lib/load-env.js";

loadContractEnv();

function requireAddressEnv(name: string): `0x${string}` {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }

  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address`);
  }

  return getAddress(value);
}

function optionalAddressEnv(name: string): `0x${string}` | null {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return null;
  }

  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address when provided`);
  }

  return getAddress(value);
}

async function main() {
  console.log("Starting deployment on 0G Galileo Testnet...");
  const { viem } = await network.connect();

  const treasuryAddr = requireAddressEnv("TREASURY_ADDR");
  const agentAddr = requireAddressEnv("AGENT_ADDR");
  const existingRegistryAddr = optionalAddressEnv("STRATEGY_REGISTRY_ADDR");

  let registryAddress: `0x${string}`;
  if (existingRegistryAddr) {
    registryAddress = existingRegistryAddr;
    console.log(`Reusing StrategyRegistry from STRATEGY_REGISTRY_ADDR: ${registryAddress}`);
  } else {
    const registry = await viem.deployContract("StrategyRegistry");
    registryAddress = getAddress(registry.address);
    console.log(`StrategyRegistry deployed to: ${registryAddress}`);
  }

  const router = await viem.deployContract("YieldGekoRouter", [
    registryAddress,
    agentAddr,
    treasuryAddr
  ]);
  const routerAddress = getAddress(router.address);
  console.log(`YieldGekoRouter deployed to: ${routerAddress}`);

  console.log("\nDeployment Complete!");
  console.log("-------------------");
  console.log(`Registry: ${registryAddress}`);
  console.log(`Router:   ${routerAddress}`);
  console.log(`Agent:    ${agentAddr}`);
  console.log(`Treasury: ${treasuryAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
