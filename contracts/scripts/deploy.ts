import { getAddress, parseEther } from "viem";
import hre from "hardhat";

async function main() {
  console.log("Starting deployment on 0G Galileo Testnet...");

  // 1. Deploy StrategyRegistry
  const registry = await hre.viem.deployContract("StrategyRegistry");
  console.log(`StrategyRegistry deployed to: ${registry.address}`);

  // 2. Setup addresses (placeholders for now, should be provided by USER or set in .env)
  const treasuryAddr = getAddress("0x0000000000000000000000000000000000000000"); // Update after deploy
  const agentAddr = getAddress("0x0000000000000000000000000000000000000000"); // Update after deploy

  // 3. Deploy YieldGekoRouter
  const router = await hre.viem.deployContract("YieldGekoRouter", [
    registry.address,
    agentAddr,
    treasuryAddr
  ]);
  console.log(`YieldGekoRouter deployed to: ${router.address}`);

  console.log("\nDeployment Complete!");
  console.log("-------------------");
  console.log(`Registry: ${registry.address}`);
  console.log(`Router:   ${router.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
