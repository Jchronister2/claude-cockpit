export type SessionState = 'idle' | 'busy' | 'waiting_input' | 'error'

export interface SessionInfo {
  id: string
  claudeSessionId?: string
  projectPath: string
  projectName: string
  state: SessionState
  command: string
  args?: string[]
  gitBranch?: string
  createdAt: number
}

export interface CreateSessionPayload {
  projectPath: string
  command?: string
  args?: string[]
}

export interface PtyDataPayload {
  sessionId: string
  data: string
}

export interface SessionStatePayload {
  sessionId: string
  state: SessionState
}

export interface PtyResizePayload {
  sessionId: string
  cols: number
  rows: number
}

// Persistence types
export interface PersistedSession {
  claudeSessionId?: string
  projectPath: string
  projectName: string
  command: string
  args: string[]
}

export interface PersistedTerminalTab {
  label: string
  cwd: string
  parentClaudeSessionId?: string  // claude session id — unique even when multiple sessions share a directory
  parentProjectPath?: string      // fallback for legacy data or when claudeSessionId is unavailable
}

export interface PersistedBrowserTab {
  url: string
  title: string
  parentClaudeSessionId?: string  // claude session id — unique even when multiple sessions share a directory
  parentProjectPath: string       // fallback for legacy data or when claudeSessionId is unavailable
}

export interface PersistedAppState {
  sessions: PersistedSession[]
  terminalTabs: PersistedTerminalTab[]
  browserTabs?: PersistedBrowserTab[]
}

// Tab types for terminal tab bar
export type TabType = 'claude' | 'terminal'

export interface TabInfo {
  id: string
  type: TabType
  sessionId?: string        // for claude tabs → SessionInfo.id
  parentSessionId?: string  // for terminal tabs → which claude session owns this tab
  label: string
  cwd?: string              // for terminal tabs
  createdAt: number
}

export interface BrowserTab {
  id: string
  url: string
  title: string
}

export interface BrowserProfile {
  id: string         // 'default', 'profile-1', etc.
  name: string       // Browser profile display name
  partition: string   // 'persist:profile-default', etc.
  chromeDir?: string  // 'Default', 'Profile 1', etc. — actual Chrome directory name
}
