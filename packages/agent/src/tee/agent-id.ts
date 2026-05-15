import { privateKeyToAccount, PrivateKeyAccount } from 'viem/accounts';
import { getAgentRuntimeConfig, getConfiguredPrivateKey } from '../config/env';

export interface AgentAttestationReport {
  mrenclave: `0x${string}`;
  publicKey: string;
  raReport: string;
  mode: 'attested' | 'development-unattested';
}

export class AgentIDManager {
  private static agentAccount: PrivateKeyAccount | null = null;

  private static getConfiguredPrivateKey(): `0x${string}` {
    return getConfiguredPrivateKey();
  }

  
  public static async initializeAgentID(): Promise<string> {
    console.log('[TEE] Loading configured Agent ID key...');

    this.agentAccount = privateKeyToAccount(this.getConfiguredPrivateKey());

    console.log(`[TEE] Agent ID Address: ${this.agentAccount.address}`);
    return this.agentAccount.address;
  }

  
  public static async generateAttestationReport(): Promise<AgentAttestationReport> {
    const account = this.getAccount();

    console.log('[TEE] Generating Remote Attestation (RA) Report...');

    const config = getAgentRuntimeConfig();

    if (config.allowUnattestedAgent) {
      console.warn(
        '[TEE] Running in explicit local development mode without attestation. This must never be used in production.'
      );
      return {
        mrenclave: `0x${'0'.repeat(64)}`,
        publicKey: account.address,
        raReport: 'UNATTESTED_LOCAL_DEVELOPMENT',
        mode: 'development-unattested',
      };
    }

    return {
      mrenclave: config.teeAttestation!.mrenclave,
      publicKey: account.address,
      raReport: config.teeAttestation!.raReport,
      mode: 'attested',
    };
  }

  public static getAccount() {
    if (!this.agentAccount) throw new Error('Agent ID not initialized');
    return this.agentAccount;
  }

  public static resetForTests(): void {
    this.agentAccount = null;
  }
}
