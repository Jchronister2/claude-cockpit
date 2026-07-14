import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import TabBar from './TabBar'
import type { SessionInfo, TabInfo } from '../../../shared/types'

interface TerminalPanelProps {
  activeSessions: SessionInfo[]
  selectedSessionId: string | null
  onSelectSession: (id: string | null) => void
  onDestroySession: (id: string) => void
}

// Manage terminal instances outside React to survive re-renders
const terminals = new Map<string, { terminal: Terminal; fit: FitAddon; opened: boolean }>()

function getOrCreateTerminal(sessionId: string): { terminal: Terminal; fit: FitAddon; opened: boolean } {
  if (terminals.has(sessionId)) {
    return terminals.get(sessionId)!
  }

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
    }
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  const entry = { terminal, fit, opened: false }
  terminals.set(sessionId, entry)
  return entry
}

export function removeTerminal(sessionId: string): void {
  const entry = terminals.get(sessionId)
  if (entry) {
    entry.terminal.dispose()
    terminals.delete(sessionId)
  }
}

// Per-session container component that opens the terminal once, then persists
function TerminalContainer({ sid, visible }: { sid: string; visible: boolean }) {
  const divRef = useRef<HTMLDivElement>(null)

  // Set up PTY data forwarding and resize observer once on mount
  useEffect(() => {
    if (!divRef.current) return

    const entry = getOrCreateTerminal(sid)

    // Custom key handling for xterm
    entry.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true
      // Ctrl+Enter → send newline (LF) so Claude Code inserts a new line
      if (event.key === 'Enter' && event.ctrlKey && !event.shiftKey && !event.altKey) {
        window.electronAPI.writePty(sid, '\n')
        return false
      }
      // Ctrl+C with selection → copy to clipboard instead of sending SIGINT
      if (event.key === 'c' && event.ctrlKey && !event.shiftKey && !event.altKey) {
        const selection = entry.terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
          return false
        }
        // No selection — let xterm send SIGINT as normal
        return true
      }
      // Ctrl+V → let browser handle paste (xterm would send raw \x16 instead)
      if (event.key === 'v' && event.ctrlKey && !event.shiftKey && !event.altKey) {
        return false
      }
      return true
    })

    // Forward user input to main process
    const onData = entry.terminal.onData((data) => {
      window.electronAPI.writePty(sid, data)
    })

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      if (entry.opened) {
        entry.fit.fit()
        window.electronAPI.resizePty({
          sessionId: sid,
          cols: entry.terminal.cols,
          rows: entry.terminal.rows
        })
      }
    })
    resizeObserver.observe(divRef.current)

    return () => {
      onData.dispose()
      resizeObserver.disconnect()
      // Reset opened flag so terminal re-attaches to new DOM on remount
      entry.opened = false
    }
  }, [sid])

  // Open terminal and fit when becoming visible.
  // xterm needs a visible container with real dimensions to render correctly.
  useEffect(() => {
    if (!visible || !divRef.current) return

    const entry = getOrCreateTerminal(sid)

    if (!entry.opened) {
      entry.terminal.open(divRef.current)
      entry.opened = true

      // Replay scrollback from main process (restores content after renderer reload)
      window.electronAPI.getScrollback(sid).then((data) => {
        if (data) entry.terminal.write(data)
      })
    }

    // Small delay to let the browser layout update before fitting
    const timer = setTimeout(() => {
      entry.fit.fit()
      // Force full redraw to clear cursor artifacts from display:none switching
      entry.terminal.refresh(0, entry.terminal.rows - 1)
      entry.terminal.focus()
    }, 50)
    return () => clearTimeout(timer)
  }, [visible, sid])

  return (
    <div
      ref={divRef}
      className="absolute inset-0"
      style={{ display: visible ? 'block' : 'none' }}
    />
  )
}

export default function TerminalPanel({
  activeSessions,
  selectedSessionId,
  onSelectSession,
  onDestroySession
}: TerminalPanelProps) {
  // All terminal tabs across all sessions
  const [terminalTabs, setTerminalTabs] = useState<TabInfo[]>([])
  // Per-session active tab: sessionId → active tab id within that session's group
  const [activeTabPerSession, setActiveTabPerSession] = useState<Map<string, string>>(new Map())

  // The currently selected session
  const selectedSession = activeSessions.find(s => s.id === selectedSessionId)

  // Build the visible tab group: this session's claude tab + its terminal tabs
  const visibleTabs = useMemo(() => {
    if (!selectedSessionId || !selectedSession) return []

    const claudeTab: TabInfo = {
      id: selectedSessionId,
      type: 'claude',
      sessionId: selectedSessionId,
      label: selectedSession.projectName,
      createdAt: selectedSession.createdAt
    }

    const sessionTerminals = terminalTabs.filter(t => t.parentSessionId === selectedSessionId)

    return [claudeTab, ...sessionTerminals]
  }, [selectedSessionId, selectedSession, terminalTabs])

  // The active tab within the current session's group
  const activeTabId = selectedSessionId
    ? (activeTabPerSession.get(selectedSessionId) || selectedSessionId)
    : null

  // Load persisted terminal tabs on mount
  useEffect(() => {
    window.electronAPI.listTerminalTabs().then((tabs: TabInfo[]) => {
      if (tabs.length > 0) {
        setTerminalTabs(prev => {
          const existingIds = new Set(prev.map(t => t.id))
          const newTabs = tabs.filter(t => !existingIds.has(t.id))
          return [...prev, ...newTabs]
        })
      }
    })
  }, [])

  // When a claude session is destroyed, also destroy its child terminal tabs
  const prevSessionIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const currentIds = new Set(activeSessions.map(s => s.id))
    const prevIds = prevSessionIdsRef.current

    for (const prevId of prevIds) {
      if (!currentIds.has(prevId)) {
        // Session was destroyed — clean up its terminal tabs
        setTerminalTabs(prev => {
          const toRemove = prev.filter(t => t.parentSessionId === prevId)
          for (const tab of toRemove) {
            window.electronAPI.destroyTerminalTab(tab.id)
            removeTerminal(tab.id)
          }
          return prev.filter(t => t.parentSessionId !== prevId)
        })
        // Clean up per-session active tab tracking
        setActiveTabPerSession(prev => {
          const next = new Map(prev)
          next.delete(prevId)
          return next
        })
      }
    }

    prevSessionIdsRef.current = currentIds
  }, [activeSessions])

  const handleSelectTab = useCallback((tabId: string) => {
    if (!selectedSessionId) return
    setActiveTabPerSession(prev => new Map(prev).set(selectedSessionId, tabId))
  }, [selectedSessionId])

  const handleCloseTab = useCallback(async (tabId: string) => {
    if (!selectedSessionId) return
    const tab = visibleTabs.find(t => t.id === tabId)
    if (!tab) return

    if (tab.type === 'claude' && tab.sessionId) {
      // Closing the claude tab destroys the whole session
      onDestroySession(tab.sessionId)
    } else if (tab.type === 'terminal') {
      await window.electronAPI.destroyTerminalTab(tabId)
      removeTerminal(tabId)
      setTerminalTabs(prev => prev.filter(t => t.id !== tabId))

      // If this was the active tab, switch back to the claude tab
      if (activeTabId === tabId) {
        setActiveTabPerSession(prev => {
          const next = new Map(prev)
          next.set(selectedSessionId, selectedSessionId) // claude tab
          return next
        })
      }
    }
  }, [visibleTabs, selectedSessionId, activeTabId, onDestroySession])

  const handleNewTerminal = useCallback(async () => {
    if (!selectedSessionId) return
    const selectedSess = activeSessions.find(s => s.id === selectedSessionId)
    const cwd = selectedSess?.projectPath || process.env.HOME || process.env.USERPROFILE || '.'

    const tab = await window.electronAPI.createTerminalTab({
      cwd,
      parentSessionId: selectedSessionId
    })
    if (tab) {
      setTerminalTabs(prev => [...prev, tab])
      setActiveTabPerSession(prev => new Map(prev).set(selectedSessionId, tab.id))
    }
  }, [activeSessions, selectedSessionId])

  const handleRenameTab = useCallback((tabId: string, newLabel: string) => {
    setTerminalTabs(prev => prev.map(t => t.id === tabId ? { ...t, label: newLabel } : t))
  }, [])

  // Global listener: route PTY data to the correct terminal regardless of selection
  useEffect(() => {
    const unsub = window.electronAPI.onPtyData((payload) => {
      const entry = terminals.get(payload.sessionId)
      if (entry) {
        entry.terminal.write(payload.data)
      }
    })
    return unsub
  }, [])

  // Listen for cwd changes detected by main process (from PowerShell prompt parsing)
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalTabCwdChanged((payload) => {
      const folderName = payload.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop()
      if (folderName) {
        setTerminalTabs(prev => prev.map(t =>
          t.id === payload.sessionId ? { ...t, label: folderName, cwd: payload.cwd } : t
        ))
      }
    })
    return cleanup
  }, [])

  // All PTY IDs that need a TerminalContainer (all sessions + all terminal tabs)
  // They all stay mounted but only the active one is visible
  const allPtyIds = [
    ...activeSessions.map(s => s.id),
    ...terminalTabs.map(t => t.id)
  ]

  // The single visible PTY
  const activeTab = visibleTabs.find(t => t.id === activeTabId)
  const visiblePtyId = activeTab?.type === 'claude' ? activeTab.sessionId : activeTab?.id

  if (!selectedSessionId || activeSessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <p>No session selected. Enter a project path and click + to start.</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TabBar
        tabs={visibleTabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onNewTerminal={handleNewTerminal}
        onRenameTab={handleRenameTab}
      />
      <div className="flex-1 min-h-0 relative">
        {allPtyIds.map(sid => (
          <TerminalContainer key={sid} sid={sid} visible={sid === visiblePtyId} />
        ))}
      </div>
    </div>
  )
}
