import { PersistedArtifact, StoragePersistenceConfig, StorageReadConfig, persistEncryptedJsonArtifact, restoreEncryptedJsonArtifact } from './persist';

export interface AgentPositionState {
  venueId: string;
  venueName: string;
  apy: number;
}

export interface AgentRuntimeState {
  schemaVersion: 1;
  userId: string;
  amount: string;
  currentPosition: AgentPositionState | null;
  updatedAt: number;
}

const AGENT_STATE_SCHEMA = 'yieldgeko.agent-runtime-state.v1';

export class AgentStateStore {
  public static async persistState(
    state: AgentRuntimeState,
    encryptionKeyBase64: string,
    config: StoragePersistenceConfig
  ): Promise<PersistedArtifact> {
    return persistEncryptedJsonArtifact(AGENT_STATE_SCHEMA, state, encryptionKeyBase64, config);
  }

  public static async restoreState(
    cid: string,
    encryptionKeyBase64: string,
    config: StorageReadConfig
  ): Promise<AgentRuntimeState> {
    const state = await restoreEncryptedJsonArtifact<AgentRuntimeState>(
      cid,
      AGENT_STATE_SCHEMA,
      encryptionKeyBase64,
      config
    );

    if (state.schemaVersion !== 1) {
      throw new Error(`Unsupported agent runtime state version: ${state.schemaVersion}`);
    }

    return state;
  }
}
