import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const provider = new ethers.JsonRpcProvider(process.env.ARB_RPC_URL!, 42161, { staticNetwork: true });
const VAULT    = process.env.VAULT_ADDRESS!;
const NFT_MGR  = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const nft      = new ethers.Contract(NFT_MGR, [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
], provider);

async function main() {
  const balance = await nft.balanceOf(VAULT) as bigint;
  console.log(`Vault owns ${balance} NFT(s)`);
  for (let i = 0n; i < balance; i++) {
    const tokenId = await nft.tokenOfOwnerByIndex(VAULT, i) as bigint;
    const pos     = await nft.positions(tokenId);
    const liquidity: bigint = pos[7];
    console.log(`  NFT ${tokenId}: liquidity=${liquidity} ${liquidity > 0n ? '← ACTIVE' : '(empty)'}`);
  }
}
main().catch(console.error);
