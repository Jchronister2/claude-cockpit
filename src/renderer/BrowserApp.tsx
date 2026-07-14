import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { BrowserTab, BrowserProfile } from '../shared/types'

export default function BrowserApp() {
  // All tabs across all sessions — keyed by sessionId
  const [tabsBySession, setTabsBySession] = useState<Map<string, BrowserTab[]>>(new Map())
  // Which session is currently active
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  // Which tab is active within each session
  const [activeTabPerSession, setActiveTabPerSession] = useState<Map<string, string>>(new Map())

  const [urlInput, setUrlInput] = useState('')
  const webviewRefs = useRef<Map<string, HTMLElement>>(new Map())

  // Profile state
  const [profiles, setProfiles] = useState<BrowserProfile[]>([])
  const [activeProfile, setActiveProfile] = useState<BrowserProfile | null>(null)
  const [importStatus, setImportStatus] = useState<string | null>(null)

  // Cookie bridge status
  const [bridgeConnected, setBridgeConnected] = useState(false)

  // Derived: the active session's tabs
  const activeTabs = activeSessionId ? (tabsBySession.get(activeSessionId) ?? []) : []
  const activeTabId = activeSessionId ? (activeTabPerSession.get(activeSessionId) ?? null) : null
  const activeTab = activeTabs.find(t => t.id === activeTabId)

  // All webviews across all sessions (for rendering — they stay mounted)
  const allWebviews: { sessionId: string; tab: BrowserTab }[] = []
  for (const [sessId, tabs] of tabsBySession) {
    for (const tab of tabs) {
      allWebviews.push({ sessionId: sessId, tab })
    }
  }

  // Load profiles on mount + check bridge status
  useEffect(() => {
    window.browserAPI.getProfiles().then(setProfiles).catch(() => {})
    window.browserAPI.getActiveProfile().then(profile => {
      if (!profile) return
      setActiveProfile(profile)
    }).catch(() => {})

    const checkBridge = () => {
      window.browserAPI.getCookieBridgeStatus().then(status => {
        setBridgeConnected(status.running)
        if (status.lastSync > 0) {
          const ago = Math.round((Date.now() - status.lastSync) / 1000)
          if (ago < 10) {
            setImportStatus(`${status.lastCookieCount} cookies synced`)
            setTimeout(() => setImportStatus(null), 5000)
          }
        }
      }).catch(() => {})
    }
    checkBridge()
    const interval = setInterval(checkBridge, 5000)
    return () => clearInterval(interval)
  }, [])

  // Listen for profile changes (from main process)
  useEffect(() => {
    return window.browserAPI.onProfileChanged((profile: BrowserProfile) => {
      setActiveProfile(profile)
    })
  }, [])

  // Listen for tab list from main process (on session switch)
  useEffect(() => {
    return window.browserAPI.onLoadTabs(({ sessionId, tabs }) => {
      if (sessionId) {
        setTabsBySession(prev => {
          const next = new Map(prev)
          // Merge: keep existing tabs that are still present, add new ones
          const existing = next.get(sessionId) ?? []
          const existingIds = new Set(existing.map(t => t.id))
          const incomingIds = new Set(tabs.map(t => t.id))

          // Keep tabs that still exist in the incoming list (preserve references for mounted webviews)
          const merged = existing.filter(t => incomingIds.has(t.id))
          // Add any new tabs not already present
          for (const t of tabs) {
            if (!existingIds.has(t.id)) merged.push(t)
          }
          next.set(sessionId, merged)
          return next
        })
        // Set active tab for this session if not already set
        setActiveTabPerSession(prev => {
          if (prev.has(sessionId)) return prev
          const next = new Map(prev)
          if (tabs.length > 0) next.set(sessionId, tabs[0].id)
          return next
        })
      }
      setActiveSessionId(sessionId)
    })
  }, [])

  // Listen for auto-detected URLs from PTY output
  useEffect(() => {
    return window.browserAPI.onUrlDetected(({ sessionId, tab }) => {
      setTabsBySession(prev => {
        const next = new Map(prev)
        const tabs = next.get(sessionId) ?? []
        if (tabs.find(t => t.id === tab.id)) return prev
        next.set(sessionId, [...tabs, tab])
        return next
      })
      // Only switch active tab if the detected URL is for the current session
      if (sessionId === activeSessionId) {
        setActiveTabPerSession(prev => {
          const next = new Map(prev)
          next.set(sessionId, tab.id)
          return next
        })
        setUrlInput(tab.url)
      }
    })
  }, [activeSessionId])

  // Attach webview event listeners
  const attachWebviewEvents = useCallback((el: HTMLElement | null, tabId: string) => {
    if (!el) return
    if (webviewRefs.current.get(tabId) === el) return
    webviewRefs.current.set(tabId, el)

    const wv = el as any

    wv.addEventListener('page-title-updated', (e: any) => {
      const title = e.title as string
      window.browserAPI.updateTab(tabId, { title })
      setTabsBySession(prev => {
        const next = new Map(prev)
        for (const [sessId, tabs] of next) {
          const idx = tabs.findIndex(t => t.id === tabId)
          if (idx >= 0) {
            const updated = [...tabs]
            updated[idx] = { ...updated[idx], title }
            next.set(sessId, updated)
            break
          }
        }
        return next
      })
    })

    wv.addEventListener('did-navigate', (e: any) => {
      const url = e.url as string
      window.browserAPI.updateTab(tabId, { url })
      updateTabUrl(tabId, url)
    })

    wv.addEventListener('did-navigate-in-page', (e: any) => {
      const url = e.url as string
      window.browserAPI.updateTab(tabId, { url })
      updateTabUrl(tabId, url)
    })
  }, [])

  const updateTabUrl = useCallback((tabId: string, url: string) => {
    setTabsBySession(prev => {
      const next = new Map(prev)
      for (const [sessId, tabs] of next) {
        const idx = tabs.findIndex(t => t.id === tabId)
        if (idx >= 0) {
          const updated = [...tabs]
          updated[idx] = { ...updated[idx], url }
          next.set(sessId, updated)
          break
        }
      }
      return next
    })
    // Update URL input if this is the currently visible tab
    setActiveTabPerSession(current => {
      if (activeSessionId && current.get(activeSessionId) === tabId) {
        setUrlInput(url)
      }
      return current
    })
  }, [activeSessionId])

  // When session changes, auto-select the last-used tab or the first tab
  useEffect(() => {
    if (!activeSessionId) return
    setActiveTabPerSession(prev => {
      if (prev.has(activeSessionId)) return prev // already has a selection
      const tabs = tabsBySession.get(activeSessionId) ?? []
      if (tabs.length === 0) return prev
      const next = new Map(prev)
      next.set(activeSessionId, tabs[0].id)
      return next
    })
  }, [activeSessionId, tabsBySession])

  // Sync URL input when switching tabs or sessions
  useEffect(() => {
    if (activeTab) setUrlInput(activeTab.url)
    else setUrlInput('')
  }, [activeTabId, activeSessionId])

  const handleNewTab = async () => {
    const result = await window.browserAPI.createTab()
    if (!result) return
    const { sessionId, tab } = result
    setActiveSessionId(sessionId)
    setTabsBySession(prev => {
      const next = new Map(prev)
      const tabs = next.get(sessionId) ?? []
      next.set(sessionId, [...tabs, tab])
      return next
    })
    setActiveTabPerSession(prev => {
      const next = new Map(prev)
      next.set(sessionId, tab.id)
      return next
    })
    setUrlInput(tab.url)
  }

  const handleCloseTab = (tabId: string) => {
    window.browserAPI.closeTab(tabId)
    webviewRefs.current.delete(tabId)
    if (!activeSessionId) return

    setTabsBySession(prev => {
      const next = new Map(prev)
      const tabs = (next.get(activeSessionId) ?? []).filter(t => t.id !== tabId)
      next.set(activeSessionId, tabs)

      // If we closed the active tab, switch to the last remaining tab
      if (activeTabId === tabId) {
        setActiveTabPerSession(prevTabs => {
          const nextTabs = new Map(prevTabs)
          const newActive = tabs.length > 0 ? tabs[tabs.length - 1].id : null
          if (newActive) {
            nextTabs.set(activeSessionId, newActive)
            setUrlInput(tabs.find(t => t.id === newActive)?.url ?? '')
          } else {
            nextTabs.delete(activeSessionId)
            setUrlInput('')
          }
          return nextTabs
        })
      }

      return next
    })
  }

  const normalizeUrl = (raw: string): string => {
    const trimmed = raw.trim()
    if (!trimmed) return 'about:blank'
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    if (/^localhost(:\d+)?/i.test(trimmed)) return 'http://' + trimmed
    if (/^[\w.-]+\.\w{2,}/.test(trimmed)) return 'https://' + trimmed
    return 'https://' + trimmed
  }

  const navigateTo = (url: string) => {
    const normalized = normalizeUrl(url)
    if (!activeTabId) return
    const wv = webviewRefs.current.get(activeTabId) as any
    if (wv && wv.loadURL) {
      wv.loadURL(normalized)
    }
    window.browserAPI.updateTab(activeTabId, { url: normalized })
    updateTabUrl(activeTabId, normalized)
    setUrlInput(normalized)
  }

  const handleUrlKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') navigateTo(urlInput)
  }

  const handleBack = () => {
    if (!activeTabId) return
    const wv = webviewRefs.current.get(activeTabId) as any
    if (wv?.goBack) wv.goBack()
  }

  const handleForward = () => {
    if (!activeTabId) return
    const wv = webviewRefs.current.get(activeTabId) as any
    if (wv?.goForward) wv.goForward()
  }

  const handleReload = () => {
    if (!activeTabId) return
    const wv = webviewRefs.current.get(activeTabId) as any
    if (wv?.reload) wv.reload()
  }

  const handleProfileChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const profileId = e.target.value
    try {
      const profile = await window.browserAPI.selectProfile(profileId)
      if (profile) {
        setActiveProfile(profile)
        setImportStatus(`Switched to ${profile.name}`)
        setTimeout(() => setImportStatus(null), 3000)
      }
    } catch (e) {
      setImportStatus(`Switch failed: ${e}`)
      setTimeout(() => setImportStatus(null), 5000)
    }
  }

  const handleCheckBridge = async () => {
    try {
      const status = await window.browserAPI.getCookieBridgeStatus()
      if (status.lastSync > 0) {
        const ago = Math.round((Date.now() - status.lastSync) / 1000)
        setImportStatus(`Last sync: ${status.lastCookieCount} cookies (${ago}s ago)`)
      } else {
        setImportStatus('No cookies received yet. Install the Chrome extension to sync.')
      }
      setTimeout(() => setImportStatus(null), 5000)
    } catch {
      setImportStatus('Bridge not running')
      setTimeout(() => setImportStatus(null), 5000)
    }
  }

  const handleDevTools = () => {
    if (!activeTabId) return
    const wv = webviewRefs.current.get(activeTabId) as any
    if (wv?.openDevTools) wv.openDevTools()
  }

  // Partition string for webview
  const partition = activeProfile?.partition ?? ''

  // Check if there are any webviews at all
  const hasAnyTabs = allWebviews.length > 0

  if (!hasAnyTabs) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-[#6c7086] text-sm">No tabs open. Select a session in the cockpit or create a new tab.</p>
        <button
          onClick={handleNewTab}
          className="px-4 py-2 bg-[#313244] hover:bg-[#45475a] text-[#cdd6f4] text-sm rounded transition-colors"
        >
          New Tab
        </button>
      </div>
    )
  }

  const isError = importStatus && (importStatus.startsWith('Error') || importStatus.startsWith('Failed') || importStatus.startsWith('Switch failed') || importStatus.startsWith('Bridge not') || importStatus.includes('No cookies'))

  return (
    <div className="h-screen flex flex-col">
      {/* Row 1: Tab bar */}
      <div className="flex items-center bg-[#181825] border-b border-[#313244] h-8 select-none">
        <div className="flex items-center overflow-x-auto flex-1 min-w-0">
          {activeTabs.map(tab => (
            <div
              key={tab.id}
              onClick={() => {
                setActiveTabPerSession(prev => {
                  const next = new Map(prev)
                  if (activeSessionId) next.set(activeSessionId, tab.id)
                  return next
                })
              }}
              className={`flex items-center gap-1 px-2.5 h-8 cursor-pointer text-[11px] border-r border-[#313244] max-w-[200px] min-w-[60px] transition-colors ${
                tab.id === activeTabId
                  ? 'bg-[#1e1e2e] text-[#cdd6f4]'
                  : 'text-[#6c7086] hover:text-[#a6adc8] hover:bg-[#1e1e2e]/50'
              }`}
            >
              <span className="truncate flex-1">{tab.title || 'New Tab'}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.id) }}
                className="text-[#6c7086] hover:text-[#f38ba8] text-[10px] flex-shrink-0 transition-colors leading-none"
              >
                &#x2715;
              </button>
            </div>
          ))}
          <button
            onClick={handleNewTab}
            className="px-2 h-8 text-[#6c7086] hover:text-[#89b4fa] text-sm flex-shrink-0 transition-colors"
            title="New tab"
          >
            &#x2795;
          </button>
        </div>
      </div>

      {/* Row 2: Navigation controls + URL bar + actions */}
      <div className="flex items-center bg-[#181825] border-b border-[#313244] h-8 px-1.5 gap-0.5 select-none">
        <button onClick={handleBack} className="w-6 h-6 flex items-center justify-center text-[#6c7086] hover:text-[#cdd6f4] text-xs rounded hover:bg-[#313244] transition-colors flex-shrink-0" title="Back">
          &#x2190;
        </button>
        <button onClick={handleForward} className="w-6 h-6 flex items-center justify-center text-[#6c7086] hover:text-[#cdd6f4] text-xs rounded hover:bg-[#313244] transition-colors flex-shrink-0" title="Forward">
          &#x2192;
        </button>
        <button onClick={handleReload} className="w-6 h-6 flex items-center justify-center text-[#6c7086] hover:text-[#cdd6f4] text-xs rounded hover:bg-[#313244] transition-colors flex-shrink-0" title="Reload">
          &#x21BB;
        </button>
        <input
          type="text"
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
          onKeyDown={handleUrlKeyDown}
          className="flex-1 min-w-0 bg-[#313244] text-[#cdd6f4] text-[11px] px-2.5 py-1 rounded outline-none focus:ring-1 focus:ring-[#89b4fa]"
          placeholder="Enter URL..."
        />
        <button onClick={handleDevTools} className="w-6 h-6 flex items-center justify-center text-[#6c7086] hover:text-[#cdd6f4] text-xs rounded hover:bg-[#313244] transition-colors flex-shrink-0" title="Open DevTools">
          &#x2699;
        </button>
        {/* Profile selector */}
        {profiles.length > 0 && (
          <select
            value={activeProfile?.id ?? ''}
            onChange={handleProfileChange}
            className="bg-[#313244] text-[#cdd6f4] text-[11px] px-1.5 py-1 rounded outline-none cursor-pointer flex-shrink-0 max-w-[100px]"
            title="Browser profile"
          >
            {profiles.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        {/* Bridge status dot */}
        <button
          onClick={handleCheckBridge}
          className={`w-6 h-6 flex items-center justify-center rounded hover:bg-[#313244] transition-colors flex-shrink-0 ${bridgeConnected ? 'text-[#a6e3a1]' : 'text-[#6c7086]'}`}
          title={bridgeConnected ? (importStatus || 'Cookie bridge active') : 'Cookie bridge waiting for Chrome extension'}
        >
          &#x25CF;
        </button>
      </div>

      {/* Webview area — ALL sessions' webviews stay mounted, only active one is visible */}
      <div className="flex-1 relative">
        {allWebviews.map(({ sessionId, tab }) => {
          const isVisible = sessionId === activeSessionId && tab.id === activeTabId
          return (
            <webview
              key={tab.id}
              ref={(el) => attachWebviewEvents(el, tab.id)}
              src={tab.url || 'about:blank'}
              partition={partition || undefined}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                display: isVisible ? 'flex' : 'none'
              }}
              allowpopups
            />
          )
        })}
      </div>
    </div>
  )
}
