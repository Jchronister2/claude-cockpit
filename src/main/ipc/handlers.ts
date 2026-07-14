import { ipcMain, BrowserWindow, Menu, dialog } from 'electron'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import { IPC } from '../../shared/ipcChannels'
import os from 'os'
import type { CreateSessionPayload, PtyResizePayload, SessionInfo, PersistedSession, PersistedTerminalTab, PersistedBrowserTab, TabInfo } from '../../shared/types'
import { PtyManager } from '../services/ptyManager'
import { discoverSessions, moveSession } from '../services/sessionDiscovery'
import { browserTabManager } from '../services/browserTabManager'
import { browserProfileManager } from '../services/browserProfileManager'
import { getCookieImportStatus } from '../services/chromeCookieImporter'
import { startCookieBridge, getBridgeStatus } from '../services/cookieBridgeServer'
import { createBrowserWindow, getBrowserWindow, onProfileChanged } from '../windows/browserWindow'
import { getGitBranch } from '../services/gitBranch'
import { loadPersistedState } from '../services/sessionPersistence'
import { log } from '../services/logger'

const sessions = new Map<string, SessionInfo>()
const terminalTabs = new Map<string, TabInfo>()
let _ptyManager: PtyManager | null = null

function createSession(
  ptyManager: PtyManager,
  mainWindow: BrowserWindow,
  projectPath: string,
  command: string,
  args: string[],
  claudeSessionId?: string
): SessionInfo {
  const id = randomUUID()
  const projectName = path.basename(projectPath)
  const hasResume = args.includes('--resume')
  const resumeTarget = hasResume ? args[args.indexOf('--resume') + 1] : undefined

  log('Session', `Creating session: ${projectName}`, {
    id: id.slice(0, 8),
    claudeSessionId: claudeSessionId?.slice(0, 12),
    hasResume,
    resumeTarget: resumeTarget?.slice(0, 12),
    args,
    projectPath
  })

  const session: SessionInfo = {
    id,
    claudeSessionId,
    projectPath,
    projectName,
    state: 'idle',
    command,
    args,
    createdAt: Date.now()
  }

  sessions.set(id, session)
  ptyManager.create(id, command, args, projectPath, 120, 30)

  // Fire-and-forget: resolve git branch after session is created
  getGitBranch(projectPath).then((branch) => {
    if (branch && sessions.has(id) && !mainWindow.isDestroyed()) {
      session.gitBranch = branch
      mainWindow.webContents.send(IPC.SESSION_GIT_BRANCH_CHANGED, { sessionId: id, gitBranch: branch })
    }
  })

  return session
}

function resolveClaudeSessionId(session: SessionInfo): string | undefined {
  if (session.claudeSessionId) {
    log('Resolve', `Already has claudeSessionId for ${session.projectName}`, {
      claudeSessionId: session.claudeSessionId.slice(0, 12)
    })
    return session.claudeSessionId
  }

  // Encode project path the same way Claude CLI does:
  // C:\Users\foo → C:/Users/foo → C-/Users/foo → C--Users-foo
  const encoded = session.projectPath.replace(/\\/g, '/').replace(/:/g, '-').replace(/\//g, '-')
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded)

  if (!fs.existsSync(projectDir)) {
    log('Resolve', `No .claude/projects dir for ${session.projectName}`, { projectDir })
    return undefined
  }

  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs
      }))
      .filter(f => f.mtime >= session.createdAt)
      .sort((a, b) => b.mtime - a.mtime)

    if (files.length > 0) {
      const resolved = files[0].name.replace('.jsonl', '')
      log('Resolve', `Resolved claudeSessionId for ${session.projectName}`, {
        resolved: resolved.slice(0, 12),
        totalCandidates: files.length,
        createdAt: new Date(session.createdAt).toISOString()
      })
      return resolved
    }
    log('Resolve', `No matching .jsonl files for ${session.projectName}`, {
      totalFiles: fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl')).length,
      createdAt: new Date(session.createdAt).toISOString()
    })
  } catch (err) {
    log('Resolve', `Error resolving for ${session.projectName}: ${(err as Error).message}`)
  }
  return undefined
}

export function getSessionsForPersistence(): PersistedSession[] {
  const all = Array.from(sessions.values())
  const filtered = all.filter(s => s.state !== 'error')
  log('Persist', `Saving ${filtered.length}/${all.length} sessions (${all.length - filtered.length} error sessions filtered)`)
  return filtered.map(s => {
      const claudeSessionId = resolveClaudeSessionId(s)
      log('Persist', `  Session: ${s.projectName}`, {
        claudeSessionId: claudeSessionId?.slice(0, 12) ?? 'NONE',
        state: s.state,
        args: s.args
      })
      return {
        claudeSessionId,
        projectPath: s.projectPath,
        projectName: s.projectName,
        command: s.command,
        args: s.args || []
      }
    })
}

export function getTerminalTabsForPersistence(): PersistedTerminalTab[] {
  log('Persist', `Saving ${terminalTabs.size} terminal tabs`)
  return Array.from(terminalTabs.values())
    .filter(t => t.cwd)
    .map(t => {
      // Use PtyManager's tracked cwd (from prompt detection) if available
      const liveCwd = _ptyManager?.getCwd(t.id)
      const cwd = liveCwd || t.cwd!
      log('Persist', `  Terminal: "${t.label}"`, {
        tabCwd: t.cwd,
        liveCwd: liveCwd ?? 'none',
        finalCwd: cwd,
        parentSessionId: t.parentSessionId?.slice(0, 8)
      })
      // Resolve parentSessionId to claude session id + project path
      let parentClaudeSessionId: string | undefined
      let parentProjectPath: string | undefined
      if (t.parentSessionId) {
        const parentSession = sessions.get(t.parentSessionId)
        if (parentSession) {
          parentClaudeSessionId = resolveClaudeSessionId(parentSession)
          parentProjectPath = parentSession.projectPath
        }
      }
      // Fallback: if no parent link, try to match terminal cwd to a session's project path
      if (!parentProjectPath) {
        const normalizedCwd = cwd.replace(/\\/g, '/')
        for (const session of sessions.values()) {
          const normalizedProject = session.projectPath.replace(/\\/g, '/')
          if (normalizedCwd.startsWith(normalizedProject)) {
            parentClaudeSessionId = resolveClaudeSessionId(session)
            parentProjectPath = session.projectPath
            break
          }
        }
      }
      return { label: t.label || path.basename(cwd), cwd, parentClaudeSessionId, parentProjectPath }
    })
}

export function getBrowserTabsForPersistence(): PersistedBrowserTab[] {
  const result: PersistedBrowserTab[] = []
  for (const [sessionId, tabs] of browserTabManager.getAllSessions()) {
    const session = sessions.get(sessionId)
    if (!session) continue
    const claudeSessionId = resolveClaudeSessionId(session)
    for (const tab of tabs) {
      if (!tab.url || tab.url === 'about:blank') continue
      result.push({
        url: tab.url,
        title: tab.title,
        parentClaudeSessionId: claudeSessionId,
        parentProjectPath: session.projectPath
      })
    }
  }
  return result
}

function restorePersistedSessions(mainWindow: BrowserWindow, ptyManager: PtyManager): void {
  const state = loadPersistedState()
  if (!state) {
    log('Restore', 'No persisted state file found')
    return
  }

  log('Restore', `Loading state: ${state.sessions.length} sessions, ${(state.terminalTabs || []).length} terminal tabs, ${(state.browserTabs || []).length} browser tabs`)

  // Two maps for re-linking: claudeSessionId is unique even when sessions share a directory
  const claudeIdToSessionId = new Map<string, string>()
  const projectPathToSessionId = new Map<string, string>()

  for (const ps of state.sessions) {
    if (!fs.existsSync(ps.projectPath)) {
      log('Restore', `Skipping session — path gone: ${ps.projectPath}`)
      continue
    }

    // Build args for restoration: if we have a claudeSessionId, resume that session
    let args = ps.args
    if (ps.claudeSessionId && !args.includes('--resume')) {
      args = ['--resume', ps.claudeSessionId, ...args.filter(a => a !== '--resume')]
    }

    log('Restore', `Restoring session: ${ps.projectName}`, {
      claudeSessionId: ps.claudeSessionId?.slice(0, 12) ?? 'NONE',
      originalArgs: ps.args,
      finalArgs: args,
      projectPath: ps.projectPath
    })
    const session = createSession(ptyManager, mainWindow, ps.projectPath, ps.command, args, ps.claudeSessionId)
    // Restore custom display name (createSession defaults to path.basename)
    if (ps.projectName && ps.projectName !== path.basename(ps.projectPath)) {
      session.projectName = ps.projectName
    }
    if (ps.claudeSessionId) {
      claudeIdToSessionId.set(ps.claudeSessionId, session.id)
    }
    projectPathToSessionId.set(ps.projectPath, session.id)
  }

  // Helper: resolve a persisted parent link to the new internal session id
  // Prefers claudeSessionId (unique) over projectPath (ambiguous when sessions share a dir)
  function resolveParent(claudeId?: string, projPath?: string, cwd?: string): string | undefined {
    if (claudeId) {
      const id = claudeIdToSessionId.get(claudeId)
      if (id) return id
    }
    if (projPath) {
      const id = projectPathToSessionId.get(projPath)
      if (id) return id
    }
    // Last resort: match cwd to a session's project path
    if (cwd) {
      const normalizedCwd = cwd.replace(/\\/g, '/')
      for (const [projP, sessId] of projectPathToSessionId) {
        if (normalizedCwd.startsWith(projP.replace(/\\/g, '/'))) {
          return sessId
        }
      }
    }
    return undefined
  }

  // Restore terminal tabs
  for (const pt of state.terminalTabs || []) {
    try {
      const stat = fs.statSync(pt.cwd)
      if (!stat.isDirectory()) {
        log('Restore', `Skipping terminal tab — not a directory: ${pt.cwd}`)
        continue
      }
    } catch {
      log('Restore', `Skipping terminal tab — cwd gone: ${pt.cwd}`)
      continue
    }
    const id = randomUUID()
    const parentSessionId = resolveParent(pt.parentClaudeSessionId, pt.parentProjectPath, pt.cwd)
    log('Restore', `Restoring terminal tab: "${pt.label}"`, {
      cwd: pt.cwd,
      parentClaudeSessionId: pt.parentClaudeSessionId?.slice(0, 12) ?? 'NONE',
      parentProjectPath: pt.parentProjectPath,
      resolvedParent: parentSessionId?.slice(0, 8) ?? 'NONE'
    })
    const tab: TabInfo = {
      id,
      type: 'terminal',
      label: pt.label,
      cwd: pt.cwd,
      parentSessionId,
      createdAt: Date.now()
    }
    terminalTabs.set(id, tab)
    ptyManager.createPlainTerminal(id, pt.cwd, 120, 30)
  }

  // Restore browser tabs
  for (const bt of state.browserTabs || []) {
    const parentSessionId = resolveParent(bt.parentClaudeSessionId, bt.parentProjectPath)
    if (!parentSessionId) {
      log('Restore', `Skipping browser tab — no matching session`, { url: bt.url, parentProjectPath: bt.parentProjectPath })
      continue
    }
    browserTabManager.addTab(parentSessionId, {
      id: randomUUID(),
      url: bt.url,
      title: bt.title
    })
    log('Restore', `Restored browser tab: ${bt.title || bt.url}`, { parent: parentSessionId.slice(0, 8) })
  }

  // Don't clear persisted state — it will be overwritten on next save.
  // This avoids losing sessions if the process is killed before the next save.
}

export function registerIpcHandlers(mainWindow: BrowserWindow, ptyManager: PtyManager): void {
  _ptyManager = ptyManager
  ptyManager.setMainWindow(mainWindow)

  // Mark session as 'error' when its PTY process exits
  ptyManager.onSessionExit((sessionId, exitCode) => {
    const session = sessions.get(sessionId)
    if (session) {
      log('Session', `PTY exited for ${session.projectName}`, {
        sessionId: sessionId.slice(0, 8),
        exitCode,
        claudeSessionId: session.claudeSessionId?.slice(0, 12) ?? 'NONE',
        args: session.args
      })
      session.state = 'error'
    }
  })

  // Keep terminalTabs map in sync when cwd changes are detected from PTY output
  ptyManager.onCwdChange((sessionId, cwd) => {
    const tab = terminalTabs.get(sessionId)
    if (tab) {
      const oldCwd = tab.cwd
      const oldLabel = tab.label
      const oldBase = path.basename(tab.cwd || '')
      // Only auto-update label if it was tracking the directory name (not a custom rename)
      if (!tab.label || tab.label === oldBase) {
        tab.label = path.basename(cwd)
      }
      tab.cwd = cwd
      log('CWD', `Terminal cwd changed`, {
        tabId: sessionId.slice(0, 8),
        oldCwd,
        newCwd: cwd,
        oldLabel,
        newLabel: tab.label
      })
    }
  })

  // Initialize profile manager and cookie bridge server
  browserProfileManager.init()
  startCookieBridge()

  ipcMain.handle(IPC.DISCOVER_SESSIONS, async () => {
    return discoverSessions()
  })

  ipcMain.handle(IPC.SESSION_RESUME, (_event, payload: { sessionId: string; projectPath: string; projectName: string }) => {
    return createSession(ptyManager, mainWindow, payload.projectPath, 'claude', ['--resume', payload.sessionId], payload.sessionId)
  })

  ipcMain.handle(IPC.SESSION_CREATE, (_event, payload: CreateSessionPayload) => {
    const command = payload.command || 'claude'
    const args = payload.args || []
    return createSession(ptyManager, mainWindow, payload.projectPath, command, args)
  })

  ipcMain.handle(IPC.SESSION_DESTROY, (_event, sessionId: string) => {
    ptyManager.destroy(sessionId)
    sessions.delete(sessionId)
    // Also destroy child terminal tabs belonging to this session
    for (const [tabId, tab] of terminalTabs) {
      if (tab.parentSessionId === sessionId) {
        ptyManager.destroy(tabId)
        terminalTabs.delete(tabId)
      }
    }
    return true
  })

  ipcMain.handle(IPC.SESSION_RENAME, (_event, sessionId: string, displayName: string) => {
    const session = sessions.get(sessionId)
    if (session) {
      session.projectName = displayName
      return true
    }
    return false
  })

  ipcMain.handle(IPC.SESSION_LIST, () => {
    return Array.from(sessions.values()).map(s => ({
      ...s,
      state: ptyManager.getState(s.id)
    }))
  })

  ipcMain.handle(IPC.PTY_SCROLLBACK, (_event, sessionId: string) => {
    return ptyManager.getScrollback(sessionId)
  })

  // Right-click context menu on project
  ipcMain.on(IPC.SHOW_PROJECT_MENU, (_event, payload: { projectPath: string; projectName: string }) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'New Session',
        click: () => {
          const session = createSession(ptyManager, mainWindow, payload.projectPath, 'claude', [])
          mainWindow.webContents.send('session:created', session)
        }
      },
      {
        label: 'New Session (Dangerously Skip Permissions)',
        click: () => {
          const session = createSession(ptyManager, mainWindow, payload.projectPath, 'claude', ['--dangerously-skip-permissions'])
          mainWindow.webContents.send('session:created', session)
        }
      },
      { type: 'separator' },
      {
        label: 'Open Folder',
        click: () => {
          require('electron').shell.openPath(payload.projectPath)
        }
      }
    ])
    menu.popup({ window: mainWindow })
  })

  // Right-click context menu on individual session
  ipcMain.on(IPC.SHOW_SESSION_MENU, (_event, payload: { sessionId: string; projectPath: string; projectName: string; summary: string }) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Resume Session',
        click: () => {
          const session = createSession(ptyManager, mainWindow, payload.projectPath, 'claude', ['--resume', payload.sessionId], payload.sessionId)
          mainWindow.webContents.send('session:created', session)
        }
      },
      {
        label: 'Resume (Dangerously Skip Permissions)',
        click: () => {
          const session = createSession(ptyManager, mainWindow, payload.projectPath, 'claude', ['--resume', payload.sessionId, '--dangerously-skip-permissions'], payload.sessionId)
          mainWindow.webContents.send('session:created', session)
        }
      },
      { type: 'separator' },
      {
        label: 'Move to...',
        click: async () => {
          const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Move session to project folder',
            defaultPath: payload.projectPath,
            properties: ['openDirectory']
          })
          if (result.canceled || result.filePaths.length === 0) return
          const targetPath = result.filePaths[0]
          console.log('[Move] sessionId:', payload.sessionId)
          console.log('[Move] from:', payload.projectPath)
          console.log('[Move] to:', targetPath)
          if (targetPath === payload.projectPath) {
            console.log('[Move] Same path, skipping')
            return
          }

          const moved = await moveSession(payload.sessionId, payload.projectPath, targetPath)
          console.log('[Move] result:', moved)
          if (moved) {
            mainWindow.webContents.send('sessions:refresh')
          } else {
            console.warn('[Move] moveSession returned false — move failed')
          }
        }
      }
    ])
    menu.popup({ window: mainWindow })
  })

  // Right-click context menu on active (running) session
  ipcMain.on(IPC.SHOW_ACTIVE_SESSION_MENU, (_event, payload: { sessionId: string; projectPath: string; projectName: string; hasBypass: boolean; claudeSessionId?: string }) => {
    // Resolve claudeSessionId from main process (renderer's value may be stale/undefined)
    const mainSession = sessions.get(payload.sessionId)
    const claudeId = mainSession ? resolveClaudeSessionId(mainSession) : payload.claudeSessionId
    log('ContextMenu', `Active session menu: ${payload.projectName}`, {
      sessionId: payload.sessionId.slice(0, 8),
      rendererClaudeId: payload.claudeSessionId?.slice(0, 12) ?? 'NONE',
      resolvedClaudeId: claudeId?.slice(0, 12) ?? 'NONE',
      hasBypass: payload.hasBypass
    })

    const restartWithArgs = (args: string[]) => {
      // Destroy old session and its child terminal tabs
      ptyManager.destroy(payload.sessionId)
      sessions.delete(payload.sessionId)
      for (const [tabId, tab] of terminalTabs) {
        if (tab.parentSessionId === payload.sessionId) {
          ptyManager.destroy(tabId)
          terminalTabs.delete(tabId)
        }
      }
      browserTabManager.clearSession(payload.sessionId)
      // Notify renderer to remove old session
      mainWindow.webContents.send('session:destroyed', payload.sessionId)
      // Create new session with the toggled args
      const session = createSession(ptyManager, mainWindow, payload.projectPath, 'claude', args, claudeId)
      session.projectName = payload.projectName
      mainWindow.webContents.send('session:created', session)
    }

    const menu = Menu.buildFromTemplate([
      {
        label: payload.hasBypass ? 'Restart Without Bypass' : 'Restart With Bypass',
        click: () => {
          const baseArgs = claudeId ? ['--resume', claudeId] : []
          if (!payload.hasBypass) {
            restartWithArgs([...baseArgs, '--dangerously-skip-permissions'])
          } else {
            restartWithArgs(baseArgs)
          }
        }
      },
      {
        label: 'Restart Session',
        click: () => {
          const session = sessions.get(payload.sessionId)
          const args = session?.args || []
          const baseArgs = claudeId ? ['--resume', claudeId] : []
          const hasBypass = args.includes('--dangerously-skip-permissions')
          restartWithArgs(hasBypass ? [...baseArgs, '--dangerously-skip-permissions'] : baseArgs)
        }
      },
      { type: 'separator' },
      {
        label: 'Open Folder',
        click: () => {
          require('electron').shell.openPath(payload.projectPath)
        }
      }
    ])
    menu.popup({ window: mainWindow })
  })

  ipcMain.on(IPC.PTY_WRITE, (_event, sessionId: string, data: string) => {
    ptyManager.write(sessionId, data)
  })

  ipcMain.on(IPC.PTY_RESIZE, (_event, payload: PtyResizePayload) => {
    ptyManager.resize(payload.sessionId, payload.cols, payload.rows)
  })

  // --- Terminal tab handlers ---

  ipcMain.handle(IPC.TERMINAL_TAB_CREATE, (_event, payload: { cwd: string; label?: string; parentSessionId?: string }) => {
    const id = randomUUID()
    const label = payload.label || path.basename(payload.cwd)
    const tab: TabInfo = {
      id,
      type: 'terminal',
      label,
      cwd: payload.cwd,
      parentSessionId: payload.parentSessionId,
      createdAt: Date.now()
    }
    terminalTabs.set(id, tab)
    ptyManager.createPlainTerminal(id, payload.cwd, 120, 30)
    return tab
  })

  ipcMain.handle(IPC.TERMINAL_TAB_DESTROY, (_event, tabId: string) => {
    ptyManager.destroy(tabId)
    terminalTabs.delete(tabId)
    return true
  })

  ipcMain.handle(IPC.TERMINAL_TAB_LIST, () => {
    // Sync latest cwd from PtyManager before returning
    for (const tab of terminalTabs.values()) {
      const liveCwd = ptyManager.getCwd(tab.id)
      if (liveCwd && liveCwd !== tab.cwd) {
        const oldBase = path.basename(tab.cwd || '')
        tab.cwd = liveCwd
        // Only auto-update label if it was tracking the directory name (not a custom rename)
        if (!tab.label || tab.label === oldBase) {
          tab.label = path.basename(liveCwd)
        }
      }
    }
    return Array.from(terminalTabs.values())
  })

  ipcMain.on(IPC.TERMINAL_TAB_UPDATE_CWD, (_event, tabId: string, cwd: string) => {
    const tab = terminalTabs.get(tabId)
    if (tab) {
      tab.cwd = cwd
      tab.label = path.basename(cwd)
    }
  })

  // --- Browser window handlers ---

  ipcMain.handle(IPC.BROWSER_OPEN, () => {
    const win = createBrowserWindow()
    // Send current session's tabs if a session is active
    const sessionId = browserTabManager.getActiveSession()
    if (sessionId) {
      const tabs = browserTabManager.getTabs(sessionId)
      win.webContents.once('did-finish-load', () => {
        win.webContents.send(IPC.BROWSER_LOAD_TABS, { sessionId, tabs })
      })
    }
    return true
  })

  ipcMain.on(IPC.BROWSER_SESSION_SWITCHED, (_event, sessionId: string | null) => {
    browserTabManager.setActiveSession(sessionId)
    const bWin = getBrowserWindow()
    if (!bWin || bWin.isDestroyed()) return
    const tabs = sessionId ? browserTabManager.getTabs(sessionId) : []
    bWin.webContents.send(IPC.BROWSER_LOAD_TABS, { sessionId, tabs })
  })

  ipcMain.handle(IPC.BROWSER_TAB_CREATE, (_event, url?: string) => {
    const sessionId = browserTabManager.getActiveSession()
    if (!sessionId) return null
    const tab = browserTabManager.createTab(sessionId, url || 'about:blank')
    if (!tab) return null
    return { sessionId, tab }
  })

  ipcMain.on(IPC.BROWSER_TAB_CLOSE, (_event, tabId: string) => {
    browserTabManager.closeTabById(tabId)
  })

  ipcMain.on(IPC.BROWSER_TAB_UPDATE, (_event, tabId: string, updates: { url?: string; title?: string }) => {
    browserTabManager.updateTabById(tabId, updates)
  })

  // --- Browser profile handlers ---

  ipcMain.handle(IPC.BROWSER_PROFILE_LIST, () => {
    return browserProfileManager.getProfiles()
  })

  ipcMain.handle(IPC.BROWSER_PROFILE_GET_ACTIVE, () => {
    return browserProfileManager.getActiveProfile()
  })

  ipcMain.handle(IPC.BROWSER_PROFILE_SELECT, async (_event, profileId: string) => {
    const profile = browserProfileManager.selectProfile(profileId)
    if (!profile) return null

    // Configure permissions for the new partition
    onProfileChanged(profile.partition)

    // Notify browser window so webviews remount with new partition
    const bWin = getBrowserWindow()
    if (bWin && !bWin.isDestroyed()) {
      bWin.webContents.send(IPC.BROWSER_PROFILE_CHANGED, profile)
    }

    return profile
  })

  ipcMain.handle(IPC.BROWSER_PROFILE_IMPORT_COOKIES, () => {
    return getCookieImportStatus()
  })

  ipcMain.handle(IPC.BROWSER_COOKIE_BRIDGE_STATUS, () => {
    return getBridgeStatus()
  })

  // Poll git branches every 30s for all active sessions
  setInterval(async () => {
    if (mainWindow.isDestroyed()) return
    for (const session of sessions.values()) {
      const branch = await getGitBranch(session.projectPath)
      if (branch !== (session.gitBranch || '')) {
        session.gitBranch = branch
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.SESSION_GIT_BRANCH_CHANGED, {
            sessionId: session.id,
            gitBranch: branch
          })
        }
      }
    }
  }, 30_000)

  // Restore sessions from previous run (must be after all handlers are registered)
  restorePersistedSessions(mainWindow, ptyManager)
}
