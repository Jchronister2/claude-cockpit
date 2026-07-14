import { app } from 'electron'
import { createMainWindow } from './windows/mainWindow'
import { registerIpcHandlers, getSessionsForPersistence, getTerminalTabsForPersistence, getBrowserTabsForPersistence } from './ipc/handlers'
import { PtyManager } from './services/ptyManager'
import { savePersistedState } from './services/sessionPersistence'

// Single instance lock — if another instance is already running, focus it and quit this one
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  const ptyManager = new PtyManager()
  let mainWindow: Electron.BrowserWindow | null = null

  function saveState() {
    savePersistedState({
      sessions: getSessionsForPersistence(),
      terminalTabs: getTerminalTabsForPersistence(),
      browserTabs: getBrowserTabsForPersistence()
    })
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    mainWindow = createMainWindow()
    registerIpcHandlers(mainWindow, ptyManager)

    // Auto-save state every 30 seconds so it survives abrupt process kills
    setInterval(saveState, 30_000)
  })

  // Save on normal quit (before windows close)
  app.on('before-quit', () => {
    saveState()
  })

  app.on('window-all-closed', () => {
    saveState()
    ptyManager.destroyAll()
    app.quit()
  })
}
