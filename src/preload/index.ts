import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipcChannels'
import type {
  CreateSessionPayload,
  SessionInfo,
  PtyDataPayload,
  PtyResizePayload
} from '../shared/types'

const api = {
  // Session discovery
  discoverSessions: (): Promise<any[]> =>
    ipcRenderer.invoke(IPC.DISCOVER_SESSIONS),

  // Session lifecycle
  createSession: (payload: CreateSessionPayload): Promise<SessionInfo> =>
    ipcRenderer.invoke(IPC.SESSION_CREATE, payload),

  resumeSession: (payload: { sessionId: string; projectPath: string; projectName: string }): Promise<SessionInfo> =>
    ipcRenderer.invoke(IPC.SESSION_RESUME, payload),

  destroySession: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.SESSION_DESTROY, sessionId),

  renameSession: (sessionId: string, displayName: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.SESSION_RENAME, sessionId, displayName),

  listSessions: (): Promise<SessionInfo[]> =>
    ipcRenderer.invoke(IPC.SESSION_LIST),

  // PTY I/O
  writePty: (sessionId: string, data: string): void => {
    ipcRenderer.send(IPC.PTY_WRITE, sessionId, data)
  },

  onPtyData: (callback: (payload: PtyDataPayload) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: PtyDataPayload) =>
      callback(payload)
    ipcRenderer.on(IPC.PTY_DATA, handler)
    return () => ipcRenderer.removeListener(IPC.PTY_DATA, handler)
  },

  onPtyExit: (callback: (payload: { sessionId: string; exitCode: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; exitCode: number }) =>
      callback(payload)
    ipcRenderer.on(IPC.PTY_EXIT, handler)
    return () => ipcRenderer.removeListener(IPC.PTY_EXIT, handler)
  },

  resizePty: (payload: PtyResizePayload): void => {
    ipcRenderer.send(IPC.PTY_RESIZE, payload)
  },

  getScrollback: (sessionId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.PTY_SCROLLBACK, sessionId),

  // Context menu
  showProjectMenu: (payload: { projectPath: string; projectName: string }): void => {
    ipcRenderer.send(IPC.SHOW_PROJECT_MENU, payload)
  },

  // Session context menu (right-click on individual session in history)
  showSessionMenu: (payload: { sessionId: string; projectPath: string; projectName: string; summary: string }): void => {
    ipcRenderer.send(IPC.SHOW_SESSION_MENU, payload)
  },

  // Active session context menu (right-click on running session)
  showActiveSessionMenu: (payload: { sessionId: string; projectPath: string; projectName: string; hasBypass: boolean; claudeSessionId?: string }): void => {
    ipcRenderer.send(IPC.SHOW_ACTIVE_SESSION_MENU, payload)
  },

  // Session created from context menu (main -> renderer)
  onSessionCreated: (callback: (session: SessionInfo) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, session: SessionInfo) =>
      callback(session)
    ipcRenderer.on('session:created', handler)
    return () => ipcRenderer.removeListener('session:created', handler)
  },

  // Session destroyed from context menu (main -> renderer)
  onSessionDestroyed: (callback: (sessionId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) =>
      callback(sessionId)
    ipcRenderer.on('session:destroyed', handler)
    return () => ipcRenderer.removeListener('session:destroyed', handler)
  },

  // Refresh signal after move (main -> renderer)
  onSessionsRefresh: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('sessions:refresh', handler)
    return () => ipcRenderer.removeListener('sessions:refresh', handler)
  },

  // State changes
  onSessionStateChanged: (callback: (payload: { sessionId: string; state: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; state: string }) =>
      callback(payload)
    ipcRenderer.on(IPC.SESSION_STATE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.SESSION_STATE_CHANGED, handler)
  },

  // Terminal tabs
  createTerminalTab: (payload: { cwd: string; label?: string; parentSessionId?: string }): Promise<any> =>
    ipcRenderer.invoke(IPC.TERMINAL_TAB_CREATE, payload),

  destroyTerminalTab: (tabId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.TERMINAL_TAB_DESTROY, tabId),

  listTerminalTabs: (): Promise<any[]> =>
    ipcRenderer.invoke(IPC.TERMINAL_TAB_LIST),

  updateTerminalTabCwd: (tabId: string, cwd: string): void => {
    ipcRenderer.send(IPC.TERMINAL_TAB_UPDATE_CWD, tabId, cwd)
  },

  onTerminalTabCwdChanged: (callback: (payload: { sessionId: string; cwd: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; cwd: string }) =>
      callback(payload)
    ipcRenderer.on(IPC.TERMINAL_TAB_CWD_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.TERMINAL_TAB_CWD_CHANGED, handler)
  },

  // Git branch changes (main -> renderer)
  onGitBranchChanged: (callback: (payload: { sessionId: string; gitBranch: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; gitBranch: string }) =>
      callback(payload)
    ipcRenderer.on(IPC.SESSION_GIT_BRANCH_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.SESSION_GIT_BRANCH_CHANGED, handler)
  },

  // Browser window
  openBrowser: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.BROWSER_OPEN),

  notifySessionSwitch: (sessionId: string | null): void => {
    ipcRenderer.send(IPC.BROWSER_SESSION_SWITCHED, sessionId)
  }
}

export type ElectronAPI = typeof api

contextBridge.exposeInMainWorld('electronAPI', api)
