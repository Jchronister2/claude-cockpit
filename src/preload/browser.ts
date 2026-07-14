import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipcChannels'
import type { BrowserTab, BrowserProfile } from '../shared/types'

const browserAPI = {
  createTab: (url?: string): Promise<{ sessionId: string; tab: BrowserTab } | null> =>
    ipcRenderer.invoke(IPC.BROWSER_TAB_CREATE, url),

  closeTab: (tabId: string): void => {
    ipcRenderer.send(IPC.BROWSER_TAB_CLOSE, tabId)
  },

  updateTab: (tabId: string, updates: Partial<Pick<BrowserTab, 'url' | 'title'>>): void => {
    ipcRenderer.send(IPC.BROWSER_TAB_UPDATE, tabId, updates)
  },

  onLoadTabs: (callback: (payload: { sessionId: string | null; tabs: BrowserTab[] }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { sessionId: string | null; tabs: BrowserTab[] }) => callback(payload)
    ipcRenderer.on(IPC.BROWSER_LOAD_TABS, handler)
    return () => ipcRenderer.removeListener(IPC.BROWSER_LOAD_TABS, handler)
  },

  // URL auto-detection from PTY output
  onUrlDetected: (callback: (payload: { sessionId: string; tab: BrowserTab }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; tab: BrowserTab }) => callback(payload)
    ipcRenderer.on(IPC.BROWSER_URL_DETECTED, handler)
    return () => ipcRenderer.removeListener(IPC.BROWSER_URL_DETECTED, handler)
  },

  // Browser profiles
  getProfiles: (): Promise<BrowserProfile[]> =>
    ipcRenderer.invoke(IPC.BROWSER_PROFILE_LIST),

  selectProfile: (id: string): Promise<BrowserProfile | null> =>
    ipcRenderer.invoke(IPC.BROWSER_PROFILE_SELECT, id),

  getActiveProfile: (): Promise<BrowserProfile> =>
    ipcRenderer.invoke(IPC.BROWSER_PROFILE_GET_ACTIVE),

  onProfileChanged: (callback: (profile: BrowserProfile) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, profile: BrowserProfile) => callback(profile)
    ipcRenderer.on(IPC.BROWSER_PROFILE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.BROWSER_PROFILE_CHANGED, handler)
  },

  importCookies: (): Promise<{ imported: number; skipped: number; error?: string }> =>
    ipcRenderer.invoke(IPC.BROWSER_PROFILE_IMPORT_COOKIES),

  getCookieBridgeStatus: (): Promise<{ running: boolean; lastSync: number; lastCookieCount: number }> =>
    ipcRenderer.invoke(IPC.BROWSER_COOKIE_BRIDGE_STATUS)
}

export type BrowserAPI = typeof browserAPI

contextBridge.exposeInMainWorld('browserAPI', browserAPI)
