const BRIDGE_URL = 'http://127.0.0.1:48721'

async function getBridgeToken() {
  const { bridgeToken = '' } = await chrome.storage.local.get('bridgeToken')
  return bridgeToken.trim()
}

async function bridgeFetch(path, options = {}) {
  const token = await getBridgeToken()
  if (token.length < 32) return null

  return fetch(`${BRIDGE_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`
    }
  })
}

async function syncCookies() {
  try {
    const ping = await bridgeFetch('/ping')
    if (!ping?.ok) return false

    const cookies = await chrome.cookies.getAll({})
    const response = await bridgeFetch('/cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cookies)
    })

    if (!response?.ok) return false
    const result = await response.json()
    console.log(`[CookieBridge] Synced ${cookies.length} cookies; ${result.imported} imported`)
    return true
  } catch {
    return false
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('cookie-sync', { periodInMinutes: 1 })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cookie-sync') syncCookies()
})

let debounceTimer = null
chrome.cookies.onChanged.addListener(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    syncCookies()
  }, 5000)
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'setToken') {
    const token = String(message.token ?? '').trim()
    if (token.length < 32) {
      sendResponse({ success: false, error: 'Token must be at least 32 characters.' })
      return
    }
    chrome.storage.local.set({ bridgeToken: token }).then(() => sendResponse({ success: true }))
    return true
  }

  if (message.action === 'getConfiguration') {
    getBridgeToken().then((token) => sendResponse({ configured: token.length >= 32 }))
    return true
  }

  if (message.action === 'syncNow') {
    syncCookies().then((success) => sendResponse({ success }))
    return true
  }

  if (message.action === 'getStatus') {
    bridgeFetch('/ping')
      .then((response) => response?.ok ? response.json() : null)
      .then((data) => sendResponse({ connected: Boolean(data), data }))
      .catch(() => sendResponse({ connected: false }))
    return true
  }
})
