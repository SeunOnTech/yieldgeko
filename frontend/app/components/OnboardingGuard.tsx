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

    
    if (status === 'ready') {
      
      if (pathname === '/app/onboard' || pathname === '/app/connect') {
        setIsRedirecting(true)
        router.replace('/app')
        return
      }
    }

    if (status === 'need_onboarding') {
      if (pathname === '/app' || pathname === '/app/create') {
        setIsRedirecting(true)
        router.replace('/app/onboard')
        return
      }
    }

    if (status === 'disconnected') {
      if (pathname === '/app' || pathname === '/app/create') {
        setIsRedirecting(true)
        router.replace('/app/connect')
        return
      }
    }

    
    setIsRedirecting(false)
  }, [status, isLoaded, pathname, router])

  
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
