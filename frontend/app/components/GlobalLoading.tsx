'use client'

import React, { useEffect, useState } from 'react'

const loadingMessages = [
  'INITIALIZING NEURAL STATE...',
  'AUTHENTICATING TEE ENVIRONMENT...',
  'SYNCING WITH 0G STORAGE...',
  'VERIFYING AGENTIC POLICY...',
  'CALIBRATING DELTA NEUTRAL ENGINES...',
  'PROVING SOVEREIGN EXECUTION...'
]

export default function GlobalLoading({ show, message }: { show: boolean; message?: string }) {
  const [msgIndex, setMsgIndex] = useState(0)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    if (!show) return
    const interval = setInterval(() => {
      setMsgIndex(prev => (prev + 1) % loadingMessages.length)
    }, 2500)
    return () => clearInterval(interval)
  }, [show])

  if (!mounted || !show) return null

  return (
    <div className="global-loader-overlay">
      <style>{`
        .global-loader-overlay {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: rgba(0, 0, 0, 0.1);
          backdrop-filter: blur(8px);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          animation: fadeIn 0.5s ease-out;
        }

        .loader-content {
          text-align: center;
          animation: popIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        .logo-container {
          position: relative;
          width: 100px;
          height: 100px;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 24px;
        }

        .logo-geko {
          animation: pulseGeko 2.5s infinite ease-in-out;
          filter: drop-shadow(0 0 15px rgba(234, 88, 12, 0.2));
        }

        .logo-path {
          stroke: white;
          stroke-width: 1.5;
          stroke-dasharray: 120;
          stroke-dashoffset: 120;
          animation: draw 4s infinite ease-in-out;
          fill: #EA580C;
          fill-opacity: 0.1;
        }

        .logo-eye {
          animation: blink 4s infinite;
          fill: #fff;
        }

        .status-text {
          font-size: 15px;
          color: white;
          font-weight: 600;
          letter-spacing: -0.01em;
          margin-top: 8px;
          opacity: 0.9;
          animation: textFade 3s infinite ease-in-out;
        }

        .sub-text {
          font-size: 12px;
          color: var(--text-muted);
          margin-top: 4px;
          font-weight: 500;
        }

        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes popIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
        @keyframes textFade { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
        
        @keyframes pulseGeko {
          0%, 100% { transform: scale(1); filter: drop-shadow(0 0 5px rgba(234, 88, 12, 0.1)); }
          50% { transform: scale(1.1); filter: drop-shadow(0 0 25px rgba(234, 88, 12, 0.5)); }
        }

        @keyframes draw {
          0%, 100% { stroke-dashoffset: 120; fill-opacity: 0.1; }
          50% { stroke-dashoffset: 0; fill-opacity: 0.9; }
        }

        @keyframes blink {
          0%, 90%, 100% { opacity: 1; }
          95% { opacity: 0; }
        }
      `}</style>

      <div className="loader-content">
        <div className="logo-container">
          <svg width="100" height="100" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" className="logo-geko">
            <g transform="translate(4, 2)"> 
              <path className="logo-path" d="M40 14c14 0 24 10 24 24a18 18 0 0 1-30 13c2 4 6 7 11 7v6c-12 0-22-9-22-22 0-15 7-28 17-28z" />
              <circle className="logo-eye" cx="48" cy="32" r="3" />
            </g>
          </svg>
        </div>

        <div className="status-text">
          {message || loadingMessages[msgIndex].split('...')[0].toLowerCase().replace(/\b\w/g, l => l.toUpperCase())}
        </div>
        <div className="sub-text">Proving on 0G Modular Stack</div>
      </div>
    </div>
  )
}
