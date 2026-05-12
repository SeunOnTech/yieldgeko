'use client'

import { useState, useEffect } from 'react'
import { useAccount } from 'wagmi'
import { VAULT_ADDRESS } from '@/config'
import { useReadYieldGekoNonces } from '@/src/generated'

export type OnboardingStatus = 'loading' | 'disconnected' | 'need_onboarding' | 'ready'

export function useOnboardingStatus() {
  const { address, isConnected, isConnecting } = useAccount()
  const [status, setStatus] = useState<OnboardingStatus>('loading')
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    let ignore = false
    const controller = new AbortController()
    
    async function resolveStatus() {
      // 1. Initial connection check
      if (isConnecting) {
        if (!ignore) {
          setStatus('loading')
          setIsLoaded(false)
        }
        return
      }

      if (!isConnected || !address) {
        if (!ignore) {
          setStatus('disconnected')
          setIsLoaded(true)
        }
        return
      }

      // 2. Resolve status based on Agent State (V2 logic)
      try {
        const agentUrl = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')
        
        // Fetch strategies for this wallet address directly
        const res = await fetch(`${agentUrl}/api/strategies/${address}`, {
          signal: controller.signal,
          headers: { 'Cache-Control': 'no-cache' }
        })
        
        if (res.ok) {
          const strategies = await res.json() as any[]
          const mine = Array.isArray(strategies) ? strategies[0] : null
          
          if (!ignore) {
            console.log('[Onboarding] Found strategy:', mine)
            const isOnboarded = !!mine
            setStatus(isOnboarded ? 'ready' : 'need_onboarding')
          }
        } else {
          if (!ignore) {
            console.warn('[Onboarding] Agent returned non-ok:', res.status)
            setStatus('need_onboarding')
          }
        }
      } catch (e) {
        if (!ignore) {
          if ((e as Error).name === 'AbortError') {
            console.warn('[Onboarding] Check aborted')
          } else {
            console.error('[Onboarding] Check failed:', e)
          }
          setStatus('need_onboarding')
        }
      } finally {
        if (!ignore) {
          setIsLoaded(true)
        }
      }
    }

    resolveStatus()
    return () => {
      ignore = true
      controller.abort()
    }
  }, [address, isConnected, isConnecting])

  return { status, isLoaded }
}
