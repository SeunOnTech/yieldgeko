#!/usr/bin/env npx ts-node
/**
 * YieldGeko — Key Generation Tool
 *
 * Generates all EOAs required to run YieldGeko in production:
 *
 *   deployer   → deploys vault, becomes owner (COLD — hardware wallet post-deploy)
 *   agent      → signs UserOperations, authorised agent on vault (HOT — server)
 *   zero_g     → signs 0G Storage uploads (HOT — server)
 *   treasury   → receives performance fees (COLD — hardware wallet or Safe)
 *
 * Security model:
 *   • Keys generated with Node.js crypto.randomBytes (OS CSPRNG — never Math.random)
 *   • Each private key encrypted as an EIP-55 / web3 keystore (scrypt + AES-128-CTR + HMAC-SHA256)
 *   • scrypt N=2^18 (262144 iterations) — same as geth production keystores
 *   • Output file written with mode 0600 (owner read-only, no group/world access)
 *   • Private keys NEVER printed to terminal — only addresses appear on screen
 *   • Smart account address fetched from Arbitrum factory via RPC (deterministic CREATE2)
 *
 * Decryption (when you need a private key for env vars):
 *   npx ts-node scripts/reveal-key.ts
 *
 * Usage:
 *   cd packages/agent
 *   npx ts-node scripts/generate-keys.ts
 */

import * as crypto  from 'node:crypto';
import * as fs      from 'node:fs';
import * as path    from 'node:path';
import { ethers, encryptKeystoreJson } from 'ethers';
import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';

// ── Simple Account factory (ERC-4337 v0.7 EntryPoint) on Arbitrum ─────────────
const SIMPLE_ACCOUNT_FACTORY_V07 = '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985';
const ENTRY_POINT_V07             = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

// ── scrypt parameters — production strength (same as geth) ───────────────────
// N=2^18 (262144 iterations): ~30s to derive, making brute-force prohibitively slow.
// Must use encryptKeystoreJson (free function) to pass scrypt options —
// wallet.encrypt() only accepts a ProgressCallback, not options.
const SCRYPT_OPTS = { scrypt: { N: 1 << 18, r: 8, p: 1 } };

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Read password from stdin without echoing characters.
 * Displays '*' for each typed character, handles backspace.
 * Ctrl+C exits cleanly.
 */
async function readPasswordHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  return new Promise<string>((resolve, reject) => {
    let password = '';

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (char: string): void => {
      switch (char) {
        case '\r':
        case '\n':
          // Enter — done
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password);
          break;
        case '':
          // Ctrl+C
          process.stdout.write('\n');
          process.stdin.setRawMode(false);
          process.exit(1);
          break;
        case '':
        case '\b':
          // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          // Regular character — show * instead
          password += char;
          process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Validate password strength.
 * Minimum requirements for a key that protects production private keys.
 */
function validatePassword(password: string): string | null {
  if (password.length < 14)
    return 'Minimum 14 characters — these keys protect real funds';
  if (!/[A-Z]/.test(password))
    return 'Include at least one uppercase letter';
  if (!/[0-9]/.test(password))
    return 'Include at least one number';
  if (!/[^A-Za-z0-9]/.test(password))
    return 'Include at least one special character (!@#$%^&* etc.)';
  return null; // valid
}

/**
 * Fetch the ERC-4337 Simple Account address for a given owner.
 * Uses the factory's getAddress() view function — requires Arbitrum RPC.
 * Falls back gracefully if network is unavailable (non-blocking).
 */
async function getSmartAccountAddress(ownerAddress: string): Promise<string | null> {
  try {
    const client = createPublicClient({
      chain:     arbitrum,
      transport: http('https://arb1.arbitrum.io/rpc'),
    });

    const FACTORY_ABI = [
      {
        name:             'getAddress',
        type:             'function',
        stateMutability:  'view',
        inputs:  [
          { name: 'owner', type: 'address' },
          { name: 'salt',  type: 'uint256' },
        ],
        outputs: [{ type: 'address' }],
      },
    ] as const;

    const address = await client.readContract({
      address:      SIMPLE_ACCOUNT_FACTORY_V07 as `0x${string}`,
      abi:          FACTORY_ABI,
      functionName: 'getAddress',
      args:         [ownerAddress as `0x${string}`, 0n],
    });

    return address as string;
  } catch (err: any) {
    // Network unavailable — not critical, agent prints this at startup
    return null;
  }
}

/**
 * Encrypt a wallet to EIP-55 keystore JSON using encryptKeystoreJson (ethers v6).
 * wallet.encrypt() only accepts a ProgressCallback — custom scrypt params require
 * the lower-level encryptKeystoreJson free function which takes EncryptOptions.
 * Handles both Wallet and HDNodeWallet (createRandom() returns HDNodeWallet in v6).
 */
async function encryptWallet(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  password: string,
): Promise<object> {
  const encrypted = await encryptKeystoreJson(
    { address: wallet.address, privateKey: wallet.privateKey },
    password,
    SCRYPT_OPTS,
  );
  return JSON.parse(encrypted);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  YieldGeko — Production Key Generation                 ║');
  console.log('║  All private keys encrypted with scrypt + AES-128-CTR  ║');
  console.log('║  Zero private keys will appear in this terminal        ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  console.log('⚠️  Recommendations before proceeding:');
  console.log('   • Run this in a private terminal (no screen sharing, no logs)');
  console.log('   • Have your password manager open and ready');
  console.log('   • This terminal session should not be recorded\n');

  // ── Step 1: Password ────────────────────────────────────────────────────────

  let password: string;
  for (;;) {
    password = await readPasswordHidden('Enter encryption password: ');
    const error = validatePassword(password);
    if (error) {
      console.log(`   ❌ ${error}\n`);
      continue;
    }

    const confirm = await readPasswordHidden('Confirm password:          ');
    if (password !== confirm) {
      console.log('   ❌ Passwords do not match\n');
      continue;
    }

    console.log('   ✅ Password accepted\n');
    break;
  }

  // ── Step 2: Generate wallets (OS CSPRNG via crypto.randomBytes) ─────────────

  console.log('🎲 Generating keys using OS CSPRNG (crypto.randomBytes)...');
  const deployer = ethers.Wallet.createRandom();
  const agent    = ethers.Wallet.createRandom();
  const zeroG    = ethers.Wallet.createRandom();
  const treasury = ethers.Wallet.createRandom();
  console.log('   ✅ 4 unique keypairs generated\n');

  // ── Step 3: Smart account address (requires Arbitrum RPC) ───────────────────

  console.log('🔎 Fetching smart account address from Arbitrum factory...');
  const smartAccountAddress = await getSmartAccountAddress(agent.address);
  if (smartAccountAddress) {
    console.log(`   ✅ Smart account: ${smartAccountAddress}\n`);
  } else {
    console.log('   ⚠️  Could not reach Arbitrum RPC — agent will print address at first startup\n');
  }

  // ── Step 4: Encrypt all keys ─────────────────────────────────────────────────

  console.log('🔐 Encrypting keys (scrypt N=2^18 — this takes ~30 seconds)...');
  const [deployerKS, agentKS, zeroGKS, treasuryKS] = await Promise.all([
    encryptWallet(deployer, password),
    encryptWallet(agent,    password),
    encryptWallet(zeroG,    password),
    encryptWallet(treasury, password),
  ]);
  console.log('   ✅ All keys encrypted\n');

  // ── Step 5: Write output file ────────────────────────────────────────────────

  const outputPath = path.resolve(__dirname, '..', '..', '..', '..', 'keys.json');

  const output = {
    _warning: 'NEVER commit this file to git. Private keys are encrypted but still sensitive.',
    _version:      '1.0',
    _generated_at: new Date().toISOString(),
    _network:      'arbitrum-mainnet',

    // ── Public addresses — safe to share ──────────────────────────────────────
    addresses: {
      deployer:            deployer.address,
      agent_eoa:           agent.address,
      agent_smart_account: smartAccountAddress ?? '(run agent once — printed at startup)',
      zero_g:              zeroG.address,
      treasury:            treasury.address,
    },

    // ── Vault deployment instructions ─────────────────────────────────────────
    vault_deployment: {
      _AGENT_param: smartAccountAddress ?? agent.address,
      _TREASURY_param: treasury.address,
      command: [
        'PRIVATE_KEY=<deployer_privkey>',
        `AGENT=${smartAccountAddress ?? agent.address}`,
        `TREASURY=${treasury.address}`,
        'DEFAULT_FEE_BPS=1000',
        'forge script script/Deploy.s.sol',
        '--rpc-url https://arb1.arbitrum.io/rpc',
        '--broadcast --verify --etherscan-api-key $ARBISCAN_API_KEY -vvvv',
      ].join(' \\\n  '),
      post_deployment: [
        '# Transfer ownership to hardware wallet / Gnosis Safe (recommended for production):',
        'cast send $VAULT_ADDRESS "transferOwnership(address)" <safe_address> --private-key <deployer_privkey>',
        '# Then accept from the Safe / hardware wallet:',
        'cast send $VAULT_ADDRESS "acceptOwnership()" --private-key <safe_privkey>',
      ].join('\n'),
    },

    // ── .env variables (values need decryption) ───────────────────────────────
    env_vars_needed: {
      'packages/agent/.env': {
        AGENT_PRIVATE_KEY:   '→ decrypt keystore: agent',
        PRIVATE_KEY:         '→ decrypt keystore: zero_g',
        PIMLICO_API_KEY:     '→ get from dashboard.pimlico.io',
        VAULT_ADDRESS:       '→ fill after deployment',
        ZG_ROUTER_ADDRESS:   '→ fill after 0G deployment',
      },
      'frontend/.env.local': {
        NEXT_PUBLIC_VAULT_ADDRESS: '→ fill after deployment',
        NEXT_PUBLIC_PROJECT_ID:    'b5113d5069f21d4590ba1f2ed0375a31',
        NEXT_PUBLIC_AGENT_SSE_URL: 'http://localhost:3001/events',
      },
    },

    // ── Encrypted EIP-55 keystores (decryptable with password above) ──────────
    // To decrypt: npx ts-node scripts/reveal-key.ts
    keystores: {
      deployer:  deployerKS,
      agent:     agentKS,
      zero_g:    zeroGKS,
      treasury:  treasuryKS,
    },

    // ── Security guidance ─────────────────────────────────────────────────────
    security: {
      deployer: {
        role:     'Vault deployer + owner (onlyOwner functions)',
        storage:  'COLD — hardware wallet (Ledger/Trezor) or Gnosis Safe in production',
        online:   'Only during deployment and rare admin operations',
        rotation: 'Transfer vault ownership to a Safe after deployment — retire this key',
        funds_needed: '~0.1 ETH on Arbitrum for deployment gas',
      },
      agent: {
        role:     'ERC-4337 smart account owner — authorizedAgent on vault',
        storage:  'HOT — encrypted environment variable on your server',
        online:   '24/7 — signs UserOperations every 60 seconds',
        rotation: 'Run new agent → get new smart account address → call vault.setAgent(newAddr) from owner',
        funds_needed: 'Smart account needs ~0.05 ETH for GMX keeper fees only (no ETH for gas — Pimlico pays)',
        note:     `vault.authorizedAgent MUST be the smart_account address: ${smartAccountAddress ?? agent.address}`,
      },
      zero_g: {
        role:     '0G Storage upload signer',
        storage:  'HOT — encrypted environment variable on your server',
        online:   'Whenever agent uploads state to 0G',
        rotation: 'Replace PRIVATE_KEY env var — no vault changes needed',
        funds_needed: '0G tokens for storage fees (testnet: free via faucet.0g.ai)',
      },
      treasury: {
        role:     'Receives performance fees (collectFee)',
        storage:  'COLD — hardware wallet or Gnosis Safe',
        online:   'Never — receives funds passively, accessed only to sweep accumulated fees',
        rotation: 'Add setTreasury(address) to vault if needed',
        funds_needed: 'None — only receives funds, does not send',
      },
      password: {
        critical:    'THIS PASSWORD IS THE ONLY WAY TO RECOVER PRIVATE KEYS',
        storage:     'Store in 1Password / Bitwarden / hardware security key RIGHT NOW',
        backup:      'Print a physical copy and store in a secure physical location',
        never:       'Never store in plaintext, never email, never message, never screenshot',
      },
    },
  };

  // Write with restrictive permissions — owner read/write only (rw-------)
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), { mode: 0o600 });
  console.log(`📁 Written to: ${outputPath}`);
  console.log('   File permissions: 0600 (only your OS user can read this file)\n');

  // ── Step 6: Add keys.json to .gitignore ──────────────────────────────────────

  const gitignorePath = path.resolve(__dirname, '..', '..', '..', '..', '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, 'utf8');
    if (!existing.includes('keys.json')) {
      fs.appendFileSync(gitignorePath, '\n# YieldGeko key store\nkeys.json\n');
      console.log('📝 Added keys.json to .gitignore\n');
    }
  } else {
    fs.writeFileSync(gitignorePath, '# YieldGeko key store\nkeys.json\n', { mode: 0o644 });
    console.log('📝 Created .gitignore with keys.json\n');
  }

  // ── Step 7: Print summary — addresses only, zero private keys ────────────────

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  GENERATED ADDRESSES (public — safe to share)\n');
  console.log(`  Deployer / Owner    : ${deployer.address}`);
  console.log(`  Agent EOA           : ${agent.address}`);
  console.log(`  Agent Smart Account : ${smartAccountAddress ?? '(run agent once to see)'}`);
  console.log(`  0G Storage          : ${zeroG.address}`);
  console.log(`  Treasury            : ${treasury.address}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('✅ NEXT STEPS (in order):\n');
  console.log('  1. STORE YOUR PASSWORD NOW in 1Password / Bitwarden');
  console.log('     Without it, these keys are permanently lost.\n');
  console.log('  2. Get AGENT_PRIVATE_KEY and PRIVATE_KEY for .env:');
  console.log('     npx ts-node scripts/reveal-key.ts\n');
  console.log('  3. Fund the deployer on Arbitrum (~0.1 ETH for deployment gas):');
  console.log(`     ${deployer.address}\n`);
  console.log('  4. Deploy the vault:');
  console.log(`     AGENT=${smartAccountAddress ?? agent.address}`);
  console.log(`     TREASURY=${treasury.address}\n`);
  if (smartAccountAddress) {
    console.log('  5. Fund the smart account (~0.05 ETH for GMX keeper fees only):');
    console.log(`     ${smartAccountAddress}\n`);
  }
  console.log('  6. Transfer vault ownership to hardware wallet / Gnosis Safe');
  console.log('     (deployer key should go cold after setup)\n');
  console.log('  7. Top up Pimlico account balance at dashboard.pimlico.io\n');

  console.log('⚠️  SECURITY CHECKLIST:');
  console.log('  □ Password saved in password manager');
  console.log('  □ keys.json is in .gitignore');
  console.log('  □ No git commit includes keys.json');
  console.log('  □ Deployer key will be moved to cold storage after deployment');
  console.log('  □ AGENT_PRIVATE_KEY set as encrypted env var on server (not plaintext)');
  console.log('  □ Smart account address (not EOA) set as vault AGENT param\n');
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
