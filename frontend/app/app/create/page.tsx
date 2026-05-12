'use client'

import AgentFlow from '../../components/AgentFlow'

/**
 * Create Agent Page
 * Reuses the same high-fidelity flow as onboarding but skips the wallet connection step.
 */
export default function CreateAgentPage() {
  return <AgentFlow mode="create" />
}
