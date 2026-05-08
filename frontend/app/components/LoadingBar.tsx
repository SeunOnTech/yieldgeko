'use client'

import { useEffect, useState, useRef } from 'react'
import { usePathname } from 'next/navigation'

export function LoadingBar() {
  const pathname   = usePathname()
  const [width, setWidth]     = useState(0)
  const [visible, setVisible] = useState(false)
  const timerRef  = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    // Clear any running timers from a previous navigation
    timerRef.current.forEach(clearTimeout)
    timerRef.current = []

    // Start: snap to 0, then animate to 85% quickly
    setVisible(true)
    setWidth(0)

    const t1 = setTimeout(() => setWidth(72),  20)
    const t2 = setTimeout(() => setWidth(90),  200)
    // "Complete" after a brief pause — fill to 100, then hide
    const t3 = setTimeout(() => setWidth(100), 350)
    const t4 = setTimeout(() => setVisible(false), 580)

    timerRef.current = [t1, t2, t3, t4]
    return () => timerRef.current.forEach(clearTimeout)
  }, [pathname])

  if (!visible) return null

  return (
    <div
      role="progressbar"
      aria-hidden="true"
      style={{
        position:   'fixed',
        top:        0,
        left:       0,
        height:     3,
        zIndex:     9999,
        pointerEvents: 'none',
        width:      `${width}%`,
        background: '#EA580C',
        transition: width === 0
          ? 'none'
          : width >= 100
            ? 'width 140ms ease-in, opacity 200ms ease 380ms'
            : 'width 280ms cubic-bezier(0.4, 0, 0.2, 1)',
        opacity:    width >= 100 ? 0 : 1,
        boxShadow:  '0 0 8px rgba(234,88,12,0.5)',
        borderRadius: '0 2px 2px 0',
      }}
    />
  )
}
