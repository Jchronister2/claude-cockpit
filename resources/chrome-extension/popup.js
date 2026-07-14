const statusEl = document.getElementById('status')
const tokenEl = document.getElementById('token')
const saveBtn = document.getElementById('saveBtn')
const syncBtn = document.getElementById('syncBtn')
const resultEl = document.getElementById('result')

function checkConnection() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    const connected = Boolean(response?.connected)
    statusEl.className = `status ${connected ? 'connected' : 'disconnected'}`
    statusEl.textContent = connected ? 'Connected to Cockpit' : 'Not connected'
    syncBtn.disabled = !connected
  })
}

chrome.runtime.sendMessage({ action: 'getConfiguration' }, (response) => {
  if (response?.configured) {
    tokenEl.placeholder = 'Token saved'
    checkConnection()
  } else {
    statusEl.textContent = 'Paste the bridge token to connect'
  }
})

saveBtn.addEventListener('click', () => {
  resultEl.textContent = ''
  chrome.runtime.sendMessage({ action: 'setToken', token: tokenEl.value }, (response) => {
    if (!response?.success) {
      resultEl.textContent = response?.error || 'Token was not saved.'
      resultEl.style.color = '#f38ba8'
      return
    }
    tokenEl.value = ''
    tokenEl.placeholder = 'Token saved'
    resultEl.textContent = 'Token saved locally in this Chrome profile.'
    resultEl.style.color = '#a6e3a1'
    checkConnection()
  })
})

syncBtn.addEventListener('click', () => {
  syncBtn.disabled = true
  syncBtn.textContent = 'Syncing...'
  resultEl.textContent = ''

  chrome.runtime.sendMessage({ action: 'syncNow' }, (response) => {
    syncBtn.textContent = 'Sync Now'
    if (response?.success) {
      resultEl.textContent = 'Cookies synced.'
      resultEl.style.color = '#a6e3a1'
      syncBtn.disabled = false
    } else {
      resultEl.textContent = 'Sync failed. Check the token and Cockpit process.'
      resultEl.style.color = '#f38ba8'
      checkConnection()
    }
  })
})
