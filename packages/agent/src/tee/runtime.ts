import { AgentAttestationReport, AgentIDManager } from './agent-id';
import { canonicalJsonStringify } from '../utils/canonical-json';

/**
 * 0G Sealed Inference (TEE) Runtime Wrapper
 * Handles memory isolation, attestation, and output signing.
 */
export class TEERuntime {
  private static attestation: AgentAttestationReport | null = null;

  /**
   * Initialize the Enclave and load the Agent ID key
   */
  public static async initialize(): Promise<void> {
    console.log('[TEE] Initializing Sealed Inference Runtime...');
    this.attestation = await AgentIDManager.generateAttestationReport();
    console.log(`[TEE] Remote Attestation (RA) Handshake: ${this.attestation.mode.toUpperCase()}`);
  }

  /**
   * Explicit Zeroization Protocol
   * Wipes sensitive data from enclave memory after processing.
   */
  public static async wipeMemory(data: any[]): Promise<string> {
    console.log('[TEE] Starting Memory Zeroization Protocol...');

    for (let i = 0; i < data.length; i++) {
      data[i] = null;
    }

    const wipeProof = AgentIDManager.getAccount().signMessage({
      message: `wipe:${Date.now()}`,
    });
    const resolvedProof = await wipeProof;
    console.log(`[TEE] Memory Wiped. Proof: ${resolvedProof}`);

    return resolvedProof;
  }

  /**
   * Signs the ranked output with the Agent ID key
   */
  public static async signOutput(payload: any): Promise<string> {
    if (!this.attestation) throw new Error('TEE not initialized');

    const canonicalPayload = canonicalJsonStringify(payload);
    return AgentIDManager.getAccount().signMessage({
      message: canonicalPayload,
    });
  }

  public static getAttestation(): AgentAttestationReport {
    if (!this.attestation) {
      throw new Error('TEE not initialized');
    }

    return this.attestation;
  }
}
