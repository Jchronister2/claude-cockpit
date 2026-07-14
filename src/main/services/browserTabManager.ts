import { randomUUID } from 'crypto'
import type { BrowserTab } from '../../shared/types'

class BrowserTabManager {
  private tabs = new Map<string, BrowserTab[]>()
  private activeSession: string | null = null

  getActiveSession(): string | null {
    return this.activeSession
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSession = sessionId
  }

  getTabs(sessionId: string): BrowserTab[] {
    return this.tabs.get(sessionId) ?? []
  }

  getAllSessions(): Map<string, BrowserTab[]> {
    return this.tabs
  }

  createTab(sessionId: string, url = 'about:blank'): BrowserTab | null {
    const list = this.tabs.get(sessionId) ?? []
    // Don't create duplicate tabs for the same URL within a session
    if (url !== 'about:blank') {
      const existing = list.find(t => t.url === url)
      if (existing) return null
    }
    const tab: BrowserTab = { id: randomUUID(), url, title: 'New Tab' }
    list.push(tab)
    this.tabs.set(sessionId, list)
    return tab
  }

  /** Add a tab with a pre-assigned ID (used for restoring persisted tabs) */
  addTab(sessionId: string, tab: BrowserTab): void {
    const list = this.tabs.get(sessionId) ?? []
    list.push(tab)
    this.tabs.set(sessionId, list)
  }

  closeTab(sessionId: string, tabId: string): void {
    const list = this.tabs.get(sessionId)
    if (!list) return
    const idx = list.findIndex(t => t.id === tabId)
    if (idx !== -1) list.splice(idx, 1)
  }

  /** Close a tab by ID, searching all sessions */
  closeTabById(tabId: string): void {
    for (const list of this.tabs.values()) {
      const idx = list.findIndex(t => t.id === tabId)
      if (idx !== -1) {
        list.splice(idx, 1)
        return
      }
    }
  }

  updateTab(sessionId: string, tabId: string, updates: Partial<Pick<BrowserTab, 'url' | 'title'>>): void {
    const list = this.tabs.get(sessionId)
    if (!list) return
    const tab = list.find(t => t.id === tabId)
    if (!tab) return
    if (updates.url !== undefined) tab.url = updates.url
    if (updates.title !== undefined) tab.title = updates.title
  }

  /** Update a tab by ID, searching all sessions */
  updateTabById(tabId: string, updates: Partial<Pick<BrowserTab, 'url' | 'title'>>): void {
    for (const list of this.tabs.values()) {
      const tab = list.find(t => t.id === tabId)
      if (tab) {
        if (updates.url !== undefined) tab.url = updates.url
        if (updates.title !== undefined) tab.title = updates.title
        return
      }
    }
  }

  /** Remove all tabs for a session */
  clearSession(sessionId: string): void {
    this.tabs.delete(sessionId)
  }
}

export const browserTabManager = new BrowserTabManager()
