'use client'

import React from 'react'

export function WalletAvatar({ address, size = 40 }: { address: string; size?: number }) {
  if (!address) return <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--surface)' }} />
  
  const seed = address.toLowerCase()
  
  // Standard blockies PRNG (Xorshift)
  const randseed = new Int32Array(4)
  function seedrand(s: string) {
    randseed.fill(0)
    for (let i = 0; i < s.length; i++) {
      randseed[i % 4] = ((randseed[i % 4] << 5) - randseed[i % 4]) + s.charCodeAt(i)
    }
  }
  function rand() {
    const t = randseed[0] ^ (randseed[0] << 11)
    randseed[0] = randseed[1]
    randseed[1] = randseed[2]
    randseed[2] = randseed[3]
    randseed[3] = (randseed[3] ^ (randseed[3] >> 19) ^ t ^ (t >> 8))
    return (randseed[3] >>> 0) / ((1 << 31) >>> 0)
  }

  function createColor() {
    const h = Math.floor(rand() * 360)
    const s = ((rand() * 60) + 40) + '%'
    const l = ((rand() + rand() + rand() + rand()) * 25) + '%'
    return `hsl(${h},${s},${l})`
  }

  seedrand(seed)
  const color = createColor()
  const bgcolor = createColor()
  const spotcolor = createColor()

  const imageData: number[] = []
  const dataWidth = 4 // 8 / 2
  for (let y = 0; y < 8; y++) {
    const row = []
    for (let x = 0; x < dataWidth; x++) {
      row[x] = Math.floor(rand() * 2.3)
    }
    const r = [...row].reverse()
    const fullRow = row.concat(r)
    for (let x = 0; x < 8; x++) {
      imageData.push(fullRow[x])
    }
  }

  return (
    <div style={{
      width: size, height: size, position: 'relative', flexShrink: 0,
      padding: size * 0.075, borderRadius: size * 0.3,
      background: 'linear-gradient(135deg, #8B5CF6, #EC4899, #3B82F6)',
    }}>
      <div style={{
        width: '100%', height: '100%', borderRadius: size * 0.25,
        background: '#fff', padding: size * 0.04,
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}>
        <div style={{
          width: '100%', height: '100%', borderRadius: size * 0.2,
          overflow: 'hidden', display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)',
        }}>
          {imageData.map((val, i) => (
            <div key={i} style={{ 
              background: val === 0 ? bgcolor : val === 1 ? color : spotcolor 
            }} />
          ))}
        </div>
      </div>
      {/* Network indicator dot */}
      <div style={{
        position: 'absolute', right: -size * 0.02, bottom: -size * 0.02, width: size * 0.25, height: size * 0.25,
        borderRadius: '50%', background: '#22C55E', border: '2px solid #1a1a1a'
      }} />
    </div>
  )
}
