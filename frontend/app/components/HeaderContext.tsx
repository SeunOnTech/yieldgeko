'use client'

import React, { createContext, useContext, useState, ReactNode, useEffect } from 'react'

interface HeaderContextType {
  setHeader: (content: ReactNode) => void
  headerContent: ReactNode
}

const HeaderContext = createContext<HeaderContextType | undefined>(undefined)

export const HeaderProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [headerContent, setHeaderContent] = useState<ReactNode>(null)

  return (
    <HeaderContext.Provider value={{ setHeader: setHeaderContent, headerContent }}>
      {children}
    </HeaderContext.Provider>
  )
}

export const useHeader = (content: ReactNode) => {
  const context = useContext(HeaderContext)
  if (!context) {
    throw new Error('useHeader must be used within a HeaderProvider')
  }

  useEffect(() => {
    context.setHeader(content)
    
    return () => context.setHeader(null)
  }, []) 
}

export const useHeaderContent = () => {
  const context = useContext(HeaderContext)
  if (!context) {
    throw new Error('useHeaderContent must be used within a HeaderProvider')
  }
  return context.headerContent
}
