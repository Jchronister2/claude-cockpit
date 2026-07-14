import React, { useState, useCallback, useEffect, useRef } from 'react'
import TerminalPanel, { removeTerminal } from './components/terminal/TerminalPanel'
import type { SessionInfo } from '../shared/types'

interface DiscoveredSession {
  sessionId: string
  projectPath: string
  projectName: string
  summary: string
  firstPrompt: string
  messageCount: number
  created: string
  modified: string
  gitBranch: string
  isRecent: boolean
}

interface ProjectGroup {
  projectPath: string
  projectName: string
  sessions: DiscoveredSession[]
}

export default function App() {
  const [projects, setProjects] = useState<ProjectGroup[]>([])
  const [activeSessions, setActiveSessions] = useState<SessionInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editSessionValue, setEditSessionValue] = useState('')
  const editSessionRef = useRef<HTMLInputElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(288) // 18rem = 288px
  const [historyCollapsed, setHistoryCollapsed] = useState(false)
  const isDragging = useRef(false)

  // Discover sessions and restore active PTY sessions on load
  useEffect(() => {
    window.electronAPI.discoverSessions().then((groups: ProjectGroup[]) => {
      setProjects(groups)
      setExpandedProjects(new Set())
      setLoading(false)
    })
    // Restore any sessions still alive in the main process (survives renderer reload)
    window.electronAPI.listSessions().then((sessions: SessionInfo[]) => {
      if (sessions.length > 0) {
        setActiveSessions(sessions)
        setSelectedId(sessions[0].id)
      }
    })
  }, [])

  const resumingRef = React.useRef(new Set<string>())

  const resumeSession = useCallback(async (discovered: DiscoveredSession) => {
    // Prevent double-resume
    if (resumingRef.current.has(discovered.sessionId)) return
    resumingRef.current.add(discovered.sessionId)

    const session = await window.electronAPI.resumeSession({
      sessionId: discovered.sessionId,
      projectPath: discovered.projectPath,
      projectName: discovered.projectName
    })
    setActiveSessions(prev => [...prev, session])
    setSelectedId(session.id)
  }, [])

  const createNewSession = useCallback(async (projectPath: string, projectName: string) => {
    const session = await window.electronAPI.createSession({
      projectPath,
      command: 'claude'
    })
    setActiveSessions(prev => [...prev, session])
    setSelectedId(session.id)
  }, [])

  const destroySession = useCallback(async (id: string) => {
    await window.electronAPI.destroySession(id)
    removeTerminal(id)
    setActiveSessions(prev => {
      const remaining = prev.filter(s => s.id !== id)
      // Auto-select another session to avoid null state that unmounts all terminals
      if (selectedId === id) {
        setSelectedId(remaining.length > 0 ? remaining[0].id : null)
      }
      return remaining
    })
  }, [selectedId])

  const toggleProject = useCallback((projectPath: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev)
      if (next.has(projectPath)) next.delete(projectPath)
      else next.add(projectPath)
      return next
    })
  }, [])

  const startEditingSession = useCallback((sessionId: string, currentName: string) => {
    setEditingSessionId(sessionId)
    setEditSessionValue(currentName)
    setTimeout(() => editSessionRef.current?.select(), 0)
  }, [])

  const commitSessionRename = useCallback(() => {
    if (editingSessionId && editSessionValue.trim()) {
      const newName = editSessionValue.trim()
      setActiveSessions(prev =>
        prev.map(s => s.id === editingSessionId ? { ...s, projectName: newName } : s)
      )
      window.electronAPI.renameSession(editingSessionId, newName)
    }
    setEditingSessionId(null)
  }, [editingSessionId, editSessionValue])

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    const startX = e.clientX
    const startWidth = sidebarWidth
    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const newWidth = Math.max(200, Math.min(500, startWidth + ev.clientX - startX))
      setSidebarWidth(newWidth)
    }
    const onUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  // Listen for sessions created via context menu (from main process)
  useEffect(() => {
    const cleanup = window.electronAPI.onSessionCreated((session: SessionInfo) => {
      setActiveSessions(prev => [...prev, session])
      setSelectedId(session.id)
    })
    return cleanup
  }, [])

  // Listen for sessions destroyed via context menu (restart with different args)
  useEffect(() => {
    const cleanup = window.electronAPI.onSessionDestroyed((sessionId: string) => {
      removeTerminal(sessionId)
      setActiveSessions(prev => {
        const remaining = prev.filter(s => s.id !== sessionId)
        if (selectedId === sessionId) {
          setSelectedId(remaining.length > 0 ? remaining[0].id : null)
        }
        return remaining
      })
    })
    return cleanup
  }, [selectedId])

  // Refresh session list after a move
  const refreshSessions = useCallback(() => {
    window.electronAPI.discoverSessions().then((groups: ProjectGroup[]) => {
      setProjects(groups)
    })
  }, [])

  useEffect(() => {
    const cleanup = window.electronAPI.onSessionsRefresh(refreshSessions)
    return cleanup
  }, [refreshSessions])

  // Notify browser window when selected session changes
  useEffect(() => {
    window.electronAPI.notifySessionSwitch(selectedId)
  }, [selectedId])

  // Listen for session state changes from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onSessionStateChanged((payload) => {
      setActiveSessions(prev =>
        prev.map(s => s.id === payload.sessionId ? { ...s, state: payload.state as SessionInfo['state'] } : s)
      )
    })
    return cleanup
  }, [])

  // Listen for git branch changes from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onGitBranchChanged((payload) => {
      setActiveSessions(prev =>
        prev.map(s => s.id === payload.sessionId ? { ...s, gitBranch: payload.gitBranch } : s)
      )
    })
    return cleanup
  }, [])

  // Check if a discovered session is already active in our app
  const isSessionActive = (claudeSessionId: string) =>
    activeSessions.some(s => s.claudeSessionId === claudeSessionId)

  const getActiveByClaudeId = (claudeSessionId: string) =>
    activeSessions.find(s => s.claudeSessionId === claudeSessionId)

  const formatTime = (iso: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return 'just now'
    if (diffMin < 60) return `${diffMin}m ago`
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return `${diffHr}h ago`
    const diffDay = Math.floor(diffHr / 24)
    return `${diffDay}d ago`
  }

  return (
    <div className="h-screen flex">
      {/* Left sidebar */}
      <div className="bg-[#181825] border-r border-[#313244] flex flex-col flex-shrink-0" style={{ width: sidebarWidth }}>
        <div className="p-3 border-b border-[#313244] flex items-center justify-between">
          <h1 className="text-sm font-bold text-[#cdd6f4]">Claude Cockpit</h1>
          <button
            onClick={() => window.electronAPI.openBrowser()}
            className="text-[10px] px-2 py-0.5 bg-[#313244] hover:bg-[#45475a] text-[#a6adc8] rounded transition-colors"
            title="Open browser window"
          >
            Browser
          </button>
        </div>

        {/* Active sessions grouped by state */}
        <div className="border-b border-[#313244]">
          {(() => {
            const active = activeSessions.filter(s => s.state === 'busy')
            const idle = activeSessions.filter(s => s.state === 'idle' || s.state === 'waiting_input')
            const errored = activeSessions.filter(s => s.state === 'error')

            const renderSession = (session: SessionInfo) => (
              <div
                key={session.id}
                onClick={() => setSelectedId(session.id)}
                onDoubleClick={() => startEditingSession(session.id, session.projectName)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const hasBypass = (session.args || []).includes('--dangerously-skip-permissions')
                  window.electronAPI.showActiveSessionMenu({
                    sessionId: session.id,
                    projectPath: session.projectPath,
                    projectName: session.projectName,
                    hasBypass,
                    claudeSessionId: session.claudeSessionId
                  })
                }}
                className={`flex items-center gap-2.5 px-3 py-2.5 cursor-pointer text-xs transition-colors ${
                  selectedId === session.id
                    ? 'bg-[#313244] text-[#cdd6f4]'
                    : 'text-[#a6adc8] hover:bg-[#1e1e2e]'
                }`}
              >
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                  session.state === 'error' ? 'bg-[#f38ba8]'
                    : session.state === 'busy' ? 'bg-session-running animate-pulse'
                    : 'bg-session-idle'
                }`} title={session.state === 'error' ? 'Session exited' : session.state} />
                {editingSessionId === session.id ? (
                  <input
                    ref={editSessionRef}
                    value={editSessionValue}
                    onChange={e => setEditSessionValue(e.target.value)}
                    onBlur={commitSessionRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitSessionRename()
                      if (e.key === 'Escape') setEditingSessionId(null)
                    }}
                    onClick={e => e.stopPropagation()}
                    className="bg-transparent text-[#cdd6f4] text-[13px] outline-none border-b border-[#89b4fa] flex-1 min-w-0"
                    autoFocus
                  />
                ) : (
                  <span className="truncate flex-1 text-[13px]">
                    {session.projectName}
                    {(session.args || []).includes('--dangerously-skip-permissions') && (
                      <span className="text-[9px] text-[#fab387] ml-1.5" title="Bypass permissions enabled">YOLO</span>
                    )}
                    {session.gitBranch && (
                      <span className="text-[10px] text-[#89b4fa] ml-1.5">{session.gitBranch}</span>
                    )}
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); destroySession(session.id) }}
                  className="text-[#6c7086] hover:text-[#f38ba8] text-[10px] transition-colors"
                >
                  x
                </button>
              </div>
            )

            if (activeSessions.length === 0) {
              return <p className="text-[#6c7086] text-[10px] px-3 py-2">No active sessions</p>
            }

            return (
              <>
                {active.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-[#a6e3a1] uppercase tracking-wider">
                      Active ({active.length})
                    </div>
                    {active.map(renderSession)}
                  </div>
                )}
                {idle.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-[#6c7086] uppercase tracking-wider">
                      Idle ({idle.length})
                    </div>
                    {idle.map(renderSession)}
                  </div>
                )}
                {errored.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-[#f38ba8] uppercase tracking-wider">
                      Exited ({errored.length})
                    </div>
                    {errored.map(renderSession)}
                  </div>
                )}
              </>
            )
          })()}
        </div>

        {/* HISTORY section */}
        <div className={`${historyCollapsed ? '' : 'flex-1'} overflow-y-auto`}>
          <div
            onClick={() => setHistoryCollapsed(prev => !prev)}
            className="px-3 py-1.5 text-[10px] font-semibold text-[#6c7086] uppercase tracking-wider cursor-pointer hover:text-[#a6adc8] transition-colors flex items-center gap-1 select-none"
          >
            <svg
              className={`w-3 h-3 transition-transform flex-shrink-0 ${historyCollapsed ? '' : 'rotate-90'}`}
              viewBox="0 0 16 16"
            >
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            History ({projects.reduce((n, g) => n + g.sessions.length, 0)})
          </div>
          {historyCollapsed ? null : loading ? (
            <p className="text-[#6c7086] text-xs p-3">Scanning sessions...</p>
          ) : (
            projects.map(group => (
              <div key={group.projectPath}>
                {/* Project header */}
                <div
                  onClick={() => toggleProject(group.projectPath)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    window.electronAPI.showProjectMenu({
                      projectPath: group.projectPath,
                      projectName: group.projectName
                    })
                  }}
                  className="flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-[#1e1e2e] transition-colors"
                >
                  <svg
                    className={`w-3 h-3 text-[#6c7086] transition-transform flex-shrink-0 ${expandedProjects.has(group.projectPath) ? 'rotate-90' : ''}`}
                    viewBox="0 0 16 16" fill="currentColor"
                  >
                    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="text-xs font-medium text-[#a6adc8] truncate flex-1">
                    {group.projectName}
                  </span>
                  <span className="text-[10px] text-[#6c7086]">{group.sessions.length}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      createNewSession(group.projectPath, group.projectName)
                    }}
                    className="text-[#6c7086] hover:text-[#89b4fa] text-xs transition-colors ml-1"
                    title="New session in this project"
                  >
                    +
                  </button>
                </div>

                {/* Session list */}
                {expandedProjects.has(group.projectPath) && (
                  <div>
                    {group.sessions.map(session => {
                      const active = getActiveByClaudeId(session.sessionId)
                      return (
                        <div
                          key={session.sessionId}
                          onClick={() => {
                            if (active) {
                              setSelectedId(active.id)
                            } else {
                              resumeSession(session)
                            }
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            window.electronAPI.showSessionMenu({
                              sessionId: session.sessionId,
                              projectPath: group.projectPath,
                              projectName: group.projectName,
                              summary: session.summary || session.firstPrompt.slice(0, 60) || 'Untitled'
                            })
                          }}
                          className={`flex items-start gap-2 px-3 pl-6 py-1.5 cursor-pointer text-[11px] transition-colors ${
                            active && selectedId === active.id
                              ? 'bg-[#313244]'
                              : 'hover:bg-[#1e1e2e]'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0 ${
                            active ? 'bg-session-running' : session.isRecent ? 'bg-session-waiting' : 'bg-session-idle'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-[#cdd6f4] truncate">
                              {session.summary || session.firstPrompt.slice(0, 60) || 'Untitled'}
                            </div>
                            <div className="text-[10px] text-[#6c7086] flex gap-2">
                              <span>{formatTime(session.modified)}</span>
                              {session.gitBranch && session.gitBranch !== 'HEAD' && (
                                <span className="text-[#89b4fa]">{session.gitBranch}</span>
                              )}
                              <span>{session.messageCount} msgs</span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        className="w-1 cursor-col-resize bg-transparent hover:bg-[#89b4fa]/30 active:bg-[#89b4fa]/50 transition-colors flex-shrink-0"
      />

      {/* Main terminal area */}
      <div className="flex-1 flex flex-col min-w-0">
        <TerminalPanel
          activeSessions={activeSessions}
          selectedSessionId={selectedId}
          onSelectSession={setSelectedId}
          onDestroySession={destroySession}
        />
      </div>
    </div>
  )
}
