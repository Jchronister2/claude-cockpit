import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import type { PersistedAppState } from '../../shared/types'

const STATE_FILE = path.join(app.getPath('userData'), 'session-state.json')

export function loadPersistedState(): PersistedAppState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null
    const raw = fs.readFileSync(STATE_FILE, 'utf-8')
    return JSON.parse(raw) as PersistedAppState
  } catch (err) {
    console.warn('[SessionPersistence] Failed to load state:', err)
    return null
  }
}

export function savePersistedState(state: PersistedAppState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
    console.log('[SessionPersistence] Saved state:', state.sessions.length, 'sessions,', state.terminalTabs.length, 'terminal tabs,', (state.browserTabs || []).length, 'browser tabs')
  } catch (err) {
    console.warn('[SessionPersistence] Failed to save state:', err)
  }
}

export function clearPersistedState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE)
    }
  } catch (err) {
    console.warn('[SessionPersistence] Failed to clear state:', err)
  }
}
