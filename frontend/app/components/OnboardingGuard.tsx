'use client'

import React, { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useOnboardingStatus } from '@/hooks/useOnboardingStatus'
import GlobalLoading from './GlobalLoading'

interface OnboardingGuardProps {
  children: React.ReactNode
}

export default function OnboardingGuard({ children }: OnboardingGuardProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { status, isLoaded } = useOnboardingStatus()
  const [isRedirecting, setIsRedirecting] = useState(false)

  useEffect(() => {
    if (!isLoaded) return

    // Logic for redirection
    if (status === 'ready') {
      // If user is already onboarded but tries to access onboarding pages, send to app
      if (pathname === '/app/onboard' || pathname === '/app/connect') {
        setIsRedirecting(true)
        router.replace('/app')
        return
      }
    }

    if (status === 'need_onboarding') {
      // If user needs onboarding but is trying to access the dashboard, send to onboard
      if (pathname === '/app' || pathname === '/app/create') {
        setIsRedirecting(true)
        router.replace('/app/onboard')
        return
      }
    }

    if (status === 'disconnected') {
      // If disconnected and trying to access protected areas
      if (pathname === '/app' || pathname === '/app/onboard' || pathname === '/app/create') {
        setIsRedirecting(true)
        router.replace('/app/connect')
        return
      }
    }

    // If we reached here, no redirect is needed
    setIsRedirecting(false)
  }, [status, isLoaded, pathname, router])

  // Show global loader during initial load or while redirecting
  const showLoader = !isLoaded || isRedirecting

  return (
    <>
      <GlobalLoading show={showLoader} />
      <div 
        className="onboarding-guard-wrapper"
        style={{ 
          visibility: showLoader ? 'hidden' : 'visible', 
          opacity: showLoader ? 0 : 1, 
          transition: 'opacity 0.4s ease',
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: '100vh'
        }}
      >
        {children}
      </div>
    </>
  )
}
