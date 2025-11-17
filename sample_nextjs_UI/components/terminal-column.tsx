'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface TerminalColumnProps {
  view: 'terminal' | 'web'
  sessionId: number
}

export function TerminalColumn({ view, sessionId }: TerminalColumnProps) {
  const [terminalLines, setTerminalLines] = useState<string[]>([
    '$ Welcome to Linux Terminal Session',
    '$ Type your commands in the chat...',
    '',
    '$ ls -la',
    'drwxr-xr-x  5 user user 4096 Nov 14 14:32 .',
    'drwxr-xr-x  3 user user 4096 Nov 14 14:30 ..',
    '-rw-r--r--  1 user user  220 Nov 14 14:30 .bash_logout',
    '-rw-r--r--  1 user user 3526 Nov 14 14:30 .bashrc',
    'drwxr-xr-x  2 user user 4096 Nov 14 14:31 documents',
    '-rw-r--r--  1 user user  807 Nov 14 14:30 .profile',
    '',
    '$ cd /var/www',
    '$ pwd',
    '/var/www',
    '',
    '$ _',
  ])
  
  const terminalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [terminalLines])

  if (view === 'web') {
    return (
      <div className="flex flex-1 items-center justify-center bg-muted/30">
        <div 
          className="rounded-lg border-3 border-black bg-card p-8 text-center"
          style={{ boxShadow: '6px 6px 0px 0px rgba(0,0,0,1)' }}
        >
          <h2 className="mb-2 font-mono text-xl font-bold text-card-foreground">Web View</h2>
          <p className="font-mono text-sm text-muted-foreground">
            Web preview will appear here
          </p>
        </div>
      </div>
    )
  }

  return (
    <div 
      ref={terminalRef}
      className="flex-1 overflow-y-auto p-6 font-mono text-sm"
      style={{ 
        backgroundColor: 'var(--terminal-bg)',
        color: 'var(--terminal-text)'
      }}
    >
      {terminalLines.map((line, index) => (
        <div key={index} className="leading-relaxed">
          {line || '\u00A0'}
        </div>
      ))}
    </div>
  )
}
