import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')

const subdirName = 'test-persist-cwd-' + Date.now()

/** Wait for session scanning to finish */
async function waitForAppReady(page: Page) {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => {
    const el = document.querySelector('body')
    return el && !el.textContent?.includes('Scanning sessions')
  }, { timeout: 15_000 })
  await page.waitForTimeout(1000)
}

// ─── Terminal CWD & Label Persistence ──────────────────────────

test.describe.serial('Terminal tab CWD persistence across restart', () => {
  let app: ElectronApplication
  let page: Page
  let stateFilePath: string
  let testProjectPath: string

  test('Phase 1: create session + terminal tab, cd into subdirectory', async () => {
    // Clear state file using the path Electron actually uses
    // First launch to discover the path, then clear and relaunch
    app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 30_000
    })

    // Get the real state file path from the main process
    const userData = await app.evaluate(async ({ app: electronApp }) => {
      return electronApp.getPath('userData')
    })
    stateFilePath = path.join(userData, 'session-state.json')
    console.log('[Test] State file path:', stateFilePath)

    // Close this instance, clear the state file, and relaunch fresh
    await app.close()

    // Delete the state file
    try {
      if (fs.existsSync(stateFilePath)) {
        fs.unlinkSync(stateFilePath)
        console.log('[Test] Cleared state file')
      }
    } catch { /* ignore */ }

    // Verify it's gone
    expect(fs.existsSync(stateFilePath)).toBe(false)

    // Relaunch fresh (no sessions to restore)
    app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 30_000
    })
    page = await app.firstWindow()
    await waitForAppReady(page)

    // Create a session by clicking the first project group "+" button
    const projectPlusBtn = page.locator('button', { hasText: '+' }).filter({ hasText: /^\+$/ }).first()
    await expect(projectPlusBtn).toBeVisible({ timeout: 5000 })
    await projectPlusBtn.click()
    await page.waitForTimeout(4000)
    await page.screenshot({ path: 'tests/screenshots/cwd-01-session-created.png' })

    // Verify we have an active session
    const activeArea = page.locator('text=/IDLE|Active/i')
    await expect(activeArea.first()).toBeVisible({ timeout: 5000 })

    // Create a terminal tab
    const newTermBtn = page.locator('button[title="New terminal"]')
    await expect(newTermBtn).toBeVisible({ timeout: 5000 })
    await newTermBtn.click()
    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'tests/screenshots/cwd-02-terminal-tab-created.png' })

    // Type into the terminal: create subdirectory and cd into it
    await page.keyboard.type(`mkdir -Force ${subdirName}`, { delay: 20 })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2000)
    await page.keyboard.type(`cd ${subdirName}`, { delay: 20 })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'tests/screenshots/cwd-03-cd-into-subdir.png' })

    // Wait for PowerShell prompt to show new CWD (triggers onCwdChange)
    // The tab label should change to the subdirectory name
    // Poll the tab labels for up to 10 seconds
    let foundSubdir = false
    for (let attempt = 0; attempt < 10; attempt++) {
      const tabLabels = page.locator('div.h-8 span.truncate')
      const tabCount = await tabLabels.count()
      for (let i = 0; i < tabCount; i++) {
        const text = await tabLabels.nth(i).textContent()
        if (text?.includes(subdirName)) {
          foundSubdir = true
          break
        }
      }
      if (foundSubdir) break
      await page.waitForTimeout(1000)
    }
    expect(foundSubdir).toBe(true)
    console.log('[Test] Tab label updated to subdirectory name')
    await page.screenshot({ path: 'tests/screenshots/cwd-04-tab-label-updated.png' })
  })

  test('Phase 2: verify in-memory terminal tab state has correct CWD', async () => {
    // Use the renderer's IPC to list terminal tabs (goes through TERMINAL_TAB_LIST handler)
    const tabs = await page.evaluate(async () => {
      return await (window as any).electronAPI.listTerminalTabs()
    })
    console.log('[Test] Terminal tabs from IPC:', JSON.stringify(tabs, null, 2))

    // Find our tab by CWD
    const testTab = tabs.find((t: any) => t.cwd?.includes(subdirName))
    console.log('[Test] Test terminal tab:', JSON.stringify(testTab, null, 2))

    expect(testTab).toBeDefined()
    expect(testTab.cwd).toContain(subdirName)
    expect(testTab.label).toContain(subdirName)
  })

  test('Phase 3: close app and verify state file has correct CWD', async () => {
    // Close the app — triggers window-all-closed → saveState()
    await app.close()

    // Wait a moment for file I/O
    await new Promise(r => setTimeout(r, 500))

    // Read the state file
    expect(fs.existsSync(stateFilePath)).toBe(true)
    const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'))
    console.log('[Test] Sessions:', state.sessions.length)
    console.log('[Test] Terminal tabs:', JSON.stringify(state.terminalTabs, null, 2))

    // Find our tab in the persisted terminal tabs
    const testTab = state.terminalTabs.find((t: any) =>
      t.cwd?.includes(subdirName)
    )
    console.log('[Test] Persisted test tab:', JSON.stringify(testTab, null, 2))

    expect(testTab).toBeDefined()
    expect(testTab.cwd).toContain(subdirName)
    expect(testTab.label).toContain(subdirName)
  })

  test('Phase 4: restart app and verify terminal tab restored with correct CWD and label', async () => {
    // State file should exist from Phase 3's close
    expect(fs.existsSync(stateFilePath)).toBe(true)

    // Relaunch the app — it should restore sessions + terminal tabs
    app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 30_000
    })
    page = await app.firstWindow()
    await waitForAppReady(page)
    await page.waitForTimeout(5000)
    await page.screenshot({ path: 'tests/screenshots/cwd-05-after-restart.png' })

    // Check that sessions were restored
    const activeArea = page.locator('text=/IDLE|Active/i')
    await expect(activeArea.first()).toBeVisible({ timeout: 10000 })

    // Click on the first session to select it
    const sessionEntries = page.locator('div.cursor-pointer.px-3')
    if (await sessionEntries.count() > 0) {
      await sessionEntries.first().click()
      await page.waitForTimeout(2000)
    }

    // Look for the terminal tab with the subdirectory name
    let foundSubdir = false
    for (let attempt = 0; attempt < 5; attempt++) {
      const tabLabels = page.locator('div.h-8 span.truncate')
      const tabCount = await tabLabels.count()
      for (let i = 0; i < tabCount; i++) {
        const text = await tabLabels.nth(i).textContent()
        console.log(`[Test] Restored tab ${i} label: "${text}"`)
        if (text?.includes(subdirName)) {
          foundSubdir = true
          break
        }
      }
      if (foundSubdir) break
      await page.waitForTimeout(1000)
    }

    await page.screenshot({ path: 'tests/screenshots/cwd-06-restored-tabs.png' })
    expect(foundSubdir).toBe(true)

    // Also verify via IPC that the restored tab has the correct CWD
    const tabs = await page.evaluate(async () => {
      return await (window as any).electronAPI.listTerminalTabs()
    })
    const restoredTab = tabs.find((t: any) => t.cwd?.includes(subdirName))
    console.log('[Test] Restored tab via IPC:', JSON.stringify(restoredTab, null, 2))

    expect(restoredTab).toBeDefined()
    expect(restoredTab.cwd).toContain(subdirName)

    // Clean up
    await app.close()
  })

  test('Cleanup: remove test directory', async () => {
    // Read the state to find the test directory's full path
    try {
      const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'))
      for (const tab of state.terminalTabs || []) {
        if (tab.cwd?.includes(subdirName)) {
          try {
            fs.rmdirSync(tab.cwd)
            console.log(`[Test] Cleaned up: ${tab.cwd}`)
          } catch (e) {
            console.log(`[Test] Could not clean up: ${tab.cwd} — ${e}`)
          }
        }
      }
    } catch { /* ignore */ }

    // Clear the state file
    try {
      if (fs.existsSync(stateFilePath)) fs.unlinkSync(stateFilePath)
    } catch { /* ignore */ }
  })
})
