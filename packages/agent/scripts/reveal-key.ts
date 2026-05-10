#!/usr/bin/env npx ts-node
/**
 * YieldGeko — Key Reveal Tool
 *
 * Decrypts a single private key from keys.json and prints it ONCE to terminal.
 * Use this to extract AGENT_PRIVATE_KEY or PRIVATE_KEY for your server .env.
 *
 * The private key appears in your terminal for ~10 seconds then the screen clears.
 * Copy it immediately into your secrets manager / .env file.
 *
 * Usage:
 *   cd packages/agent
 *   npx ts-node scripts/reveal-key.ts
 */

import * as fs       from 'node:fs';
import * as path     from 'node:path';
import * as readline from 'node:readline';
import { ethers } from 'ethers';

const KEYS_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'keys.json');
const REVEAL_SECONDS = 15; // seconds before screen clear

async function readPasswordHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  return new Promise<string>((resolve) => {
    let password = '';

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (char: string): void => {
      switch (char) {
        case '\r':
        case '\n':
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password);
          break;
        case '':
          process.stdout.write('\n');
          process.stdin.setRawMode(false);
          process.exit(1);
          break;
        case '':
        case '\b':
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          password += char;
          process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

async function selectKey(keys: Record<string, object>): Promise<string> {
  const available = Object.keys(keys);

  console.log('\nAvailable keys:');
  available.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));
  console.log('');

  // Use readline for clean line-based input — avoids raw-mode leftover state
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    const ask = (): void => {
      rl.question('Select key number (1–' + available.length + '): ', (answer) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        if (idx >= 0 && idx < available.length) {
          rl.close();
          resolve(available[idx]);
        } else {
          console.log(`  Please enter a number between 1 and ${available.length}`);
          ask();
        }
      });
    };
    ask();
  });
}

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  YieldGeko — Key Reveal Tool                     ║');
  console.log('║  Private key shown ONCE then screen clears       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── Check keys.json exists ────────────────────────────────────────────────

  if (!fs.existsSync(KEYS_PATH)) {
    console.error(`❌ keys.json not found at: ${KEYS_PATH}`);
    console.error('   Run: npx ts-node scripts/generate-keys.ts');
    process.exit(1);
  }

  const store = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));

  // ── Show address summary ──────────────────────────────────────────────────

  if (store.addresses) {
    console.log('Stored addresses:');
    Object.entries(store.addresses).forEach(([k, v]) => {
      console.log(`  ${k.padEnd(22)}: ${v}`);
    });
  }

  // ── Select which key ──────────────────────────────────────────────────────

  const keystores: Record<string, object> = store.keystores ?? {};
  if (Object.keys(keystores).length === 0) {
    console.error('❌ No keystores found in keys.json');
    process.exit(1);
  }

  const keyName = await selectKey(keystores);
  const keystore = keystores[keyName];

  // ── Decrypt ───────────────────────────────────────────────────────────────

  const password = await readPasswordHidden('\nEncryption password: ');

  console.log('\n🔓 Decrypting...');
  // ethers v6: fromEncryptedJson returns Wallet | HDNodeWallet
  let wallet: ethers.Wallet | ethers.HDNodeWallet;
  try {
    wallet = await ethers.Wallet.fromEncryptedJson(
      JSON.stringify(keystore),
      password,
    );
  } catch {
    console.error('❌ Decryption failed — wrong password or corrupted keystore');
    process.exit(1);
  }

  // ── Show key — clears after REVEAL_SECONDS ────────────────────────────────

  console.clear();
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  KEY: ${keyName.toUpperCase()}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log(`  Address      : ${wallet.address}`);
  console.log(`  Private key  : ${wallet.privateKey}\n`);

  if (keyName === 'agent') {
    console.log('  → Set as: AGENT_PRIVATE_KEY in packages/agent/.env');
    if (store.addresses?.agent_smart_account) {
      console.log(`  → Vault AGENT param must be: ${store.addresses.agent_smart_account}`);
      console.log('    (the smart account address, NOT this EOA address)');
    }
  }
  if (keyName === 'zero_g') {
    console.log('  → Set as: PRIVATE_KEY in packages/agent/.env');
  }
  if (keyName === 'deployer') {
    console.log('  → Use for vault deployment, then move to cold storage');
    console.log('  → Transfer vault ownership to hardware wallet / Safe after deployment');
  }
  if (keyName === 'treasury') {
    console.log('  → Treasury address only needed for vault deployment');
    console.log('  → Store private key in cold storage — only used to sweep fees');
  }

  console.log('\n⚠️  Copy this key NOW. Screen clears in', REVEAL_SECONDS, 'seconds.\n');
  console.log('═══════════════════════════════════════════════════════════════');

  await new Promise<void>((resolve) => setTimeout(resolve, REVEAL_SECONDS * 1000));

  console.clear();
  console.log('\n✅ Screen cleared. Key is no longer visible in terminal.\n');
  console.log('   If you need it again: npx ts-node scripts/reveal-key.ts\n');
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
