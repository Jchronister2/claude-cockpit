import { BrowserWindow, session } from 'electron'
import { join } from 'path'
import { browserProfileManager } from '../services/browserProfileManager'

let browserWindow: BrowserWindow | null = null

export function getBrowserWindow(): BrowserWindow | null {
  return browserWindow
}

/** Configure permissions (clipboard, media, notifications) for a partition's session */
function configureSessionPermissions(partition: string): void {
  const ses = session.fromPartition(partition)
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['clipboard-read', 'clipboard-sanitized-write', 'media', 'notifications']
    callback(allowed.includes(permission))
  })
}

export function createBrowserWindow(): BrowserWindow {
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.focus()
    return browserWindow
  }

  // Initialize profile manager (no-op if already done)
  browserProfileManager.init()

  // Configure permissions for the active profile
  const activeProfile = browserProfileManager.getActiveProfile()
  if (activeProfile) configureSessionPermissions(activeProfile.partition)

  browserWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Browser',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/browser.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    browserWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/browser.html')
  } else {
    browserWindow.loadFile(join(__dirname, '../renderer/browser.html'))
  }

  browserWindow.on('closed', () => {
    browserWindow = null
  })

  return browserWindow
}

/** Reconfigure permissions when profile changes */
export function onProfileChanged(partition: string): void {
  configureSessionPermissions(partition)
}
