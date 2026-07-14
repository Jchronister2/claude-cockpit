import { getBridgeStatus } from './cookieBridgeServer'

export interface ImportResult {
  imported: number
  skipped: number
  error?: string
}

/**
 * Get the latest cookie import status from the bridge server.
 *
 * Cookies are imported automatically when the Chrome extension sends them
 * to the local bridge server. This function just returns the current status.
 */
export function getCookieImportStatus(): ImportResult {
  const status = getBridgeStatus()

  if (!status.running) {
    return { imported: 0, skipped: 0, error: 'Cookie bridge server not running' }
  }

  if (status.lastSync === 0) {
    return {
      imported: 0,
      skipped: 0,
      error: 'No cookies received yet. Install the Cockpit Cookie Bridge extension in Chrome and click it to sync.'
    }
  }

  return {
    imported: status.lastCookieCount,
    skipped: 0
  }
}
