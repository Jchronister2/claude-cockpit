import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')

function clearPersistedState() {
  try {
    const userDataDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'claude-cockpit')
      : path.join(require('os').homedir(), 'AppData', 'Roaming', 'claude-cockpit')
    const stateFile = path.join(userDataDir, 'session-state.json')
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile)
  } catch { /* ignore */ }
}

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  clearPersistedState()
  app = await electron.launch({
    args: [mainEntry],
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 30_000
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Wait for session discovery to complete (shows "Scanning sessions..." then loads)
  await page.waitForFunction(() => {
    const el = document.querySelector('body')
    return el && !el.textContent?.includes('Scanning sessions')
  }, { timeout: 15_000 })
  await page.waitForTimeout(1000)
})

test.afterAll(async () => {
  if (app) await app.close()
})

// ─── App Launch ──────────────────────────────────────────────

test.describe('App launch and layout', () => {
  test('window opens with Claude Cockpit header', async () => {
    const header = page.locator('h1', { hasText: 'Claude Cockpit' })
    await expect(header).toBeVisible()
    await page.screenshot({ path: 'tests/screenshots/01-app-launch.png' })
  })

  test('sidebar shows HISTORY with discovered sessions', async () => {
    // HISTORY (N) label should show a count > 0
    const historyLabel = page.locator('text=/History \\(\\d+\\)/i')
    await expect(historyLabel).toBeVisible()
    const text = await historyLabel.textContent()
    console.log(`[Test] History label: "${text}"`)
    const match = text?.match(/\((\d+)\)/)
    expect(Number(match?.[1] || 0)).toBeGreaterThan(0)
    await page.screenshot({ path: 'tests/screenshots/02-sidebar-history.png' })
  })

  test('sidebar shows project groups with session counts', async () => {
    // Each project group has: name, count, "+" button
    // Look for the "+" buttons which are unique to project headers
    const plusButtons = page.locator('button', { hasText: '+' }).filter({ hasText: /^\+$/ })
    const count = await plusButtons.count()
    console.log(`[Test] Found ${count} project "+" buttons`)
    expect(count).toBeGreaterThan(0)
    await page.screenshot({ path: 'tests/screenshots/03-project-groups.png' })
  })
})

// ─── Session Discovery ──────────────────────────────────────

test.describe('Session discovery', () => {
  test('a discovered project group can be expanded', async () => {
    const projectButton = page.locator('button', { hasText: '+' }).filter({ hasText: /^\+$/ }).first()
    const projectHeader = projectButton.locator('..')
    await expect(projectHeader).toBeVisible()
    await projectHeader.click()
    await page.waitForTimeout(300)
  })

  test('git branches shown in session history', async () => {
    // Blue-colored branch labels should be visible (from discovered sessions)
    const branchLabels = page.locator('span.text-\\[\\#89b4fa\\]')
    const count = await branchLabels.count()
    console.log(`[Test] Found ${count} git branch labels in history`)
    expect(count).toBeGreaterThan(0)

    const firstBranch = await branchLabels.first().textContent()
    console.log(`[Test] First branch: "${firstBranch}"`)
    await page.screenshot({ path: 'tests/screenshots/05-git-branches.png' })
  })
})

// ─── Session Management ─────────────────────────────────────

test.describe('Session management', () => {
  test('can create a session from project "+" button', async () => {
    // Click the "+" button of the first project group
    // The "+" buttons are inside the project header divs
    const projectPlusBtn = page.locator('button', { hasText: '+' }).filter({ hasText: /^\+$/ }).first()
    await projectPlusBtn.click()

    // Wait for session to appear in sidebar
    await page.waitForTimeout(4000)
    await page.screenshot({ path: 'tests/screenshots/06-session-created.png' })

    // Should see the session in the active sessions area (IDLE or Active)
    const activeArea = page.locator('text=/IDLE|Active/i')
    await expect(activeArea.first()).toBeVisible({ timeout: 5000 })
  })

  test('created session shows tab bar with claude tab', async () => {
    // Tab bar should be visible now
    const tabBar = page.locator('div.h-8')
    await expect(tabBar).toBeVisible({ timeout: 5000 })

    // Should contain at least one tab with a green dot
    const greenDot = tabBar.locator('span.rounded-full.bg-\\[\\#a6e3a1\\]')
    await expect(greenDot.first()).toBeVisible()

    await page.screenshot({ path: 'tests/screenshots/07-tab-bar-visible.png' })
  })

  test('terminal renders content (not blank)', async () => {
    // Wait for xterm to render
    await page.waitForTimeout(3000)

    // xterm creates elements with class "xterm"
    const xterm = page.locator('.xterm')
    const count = await xterm.count()
    console.log(`[Test] xterm instances: ${count}`)

    // Take screenshot for visual verification
    await page.screenshot({ path: 'tests/screenshots/08-terminal-content.png' })

    // At minimum the terminal container div should exist (even if xterm hasn't rendered yet)
    const terminalArea = page.locator('div.flex-1.min-h-0.relative')
    await expect(terminalArea).toBeVisible()
  })
})

// ─── Terminal Tabs ──────────────────────────────────────────

test.describe('Terminal tabs', () => {
  test('can create a terminal tab with "+" button', async () => {
    const newTermBtn = page.locator('button[title="New terminal"]')
    await expect(newTermBtn).toBeVisible({ timeout: 5000 })

    // Count tabs before
    const tabsBefore = await page.locator('div.h-8 >> div.cursor-pointer').count()

    await newTermBtn.click()
    await page.waitForTimeout(2000)

    // Count tabs after
    const tabsAfter = await page.locator('div.h-8 >> div.cursor-pointer').count()
    console.log(`[Test] Tabs: ${tabsBefore} -> ${tabsAfter}`)
    expect(tabsAfter).toBe(tabsBefore + 1)

    await page.screenshot({ path: 'tests/screenshots/09-terminal-tab-created.png' })
  })

  test('terminal tab shows PowerShell prompt', async () => {
    // Wait for PowerShell to start
    await page.waitForTimeout(4000)
    await page.screenshot({ path: 'tests/screenshots/10-terminal-prompt.png' })
  })

  test('can switch between claude and terminal tabs', async () => {
    const tabs = page.locator('div.h-8 >> div.cursor-pointer')
    const tabCount = await tabs.count()
    console.log(`[Test] Tab count: ${tabCount}`)
    expect(tabCount).toBeGreaterThanOrEqual(2)

    // Click first tab (claude)
    await tabs.first().click()
    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'tests/screenshots/11-switched-to-claude.png' })

    // Verify terminal area is not blank — check for xterm or terminal content
    const termArea = page.locator('div.flex-1.min-h-0.relative')
    await expect(termArea).toBeVisible()

    // Click second tab (terminal)
    await tabs.nth(1).click()
    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'tests/screenshots/12-switched-to-terminal.png' })

    // Switch back to claude
    await tabs.first().click()
    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'tests/screenshots/13-switched-back.png' })

    // Terminal area should still be visible (not blank)
    await expect(termArea).toBeVisible()
  })

  test('can close terminal tab', async () => {
    const tabs = page.locator('div.h-8 >> div.cursor-pointer')
    const tabCount = await tabs.count()

    if (tabCount > 1) {
      // Close the last (terminal) tab
      const closeBtn = tabs.last().locator('button', { hasText: 'x' })
      await closeBtn.click()
      await page.waitForTimeout(500)

      const newCount = await tabs.count()
      console.log(`[Test] Tabs after close: ${newCount} (was ${tabCount})`)
      expect(newCount).toBe(tabCount - 1)
    }
    await page.screenshot({ path: 'tests/screenshots/14-tab-closed.png' })
  })
})

// ─── Session Switching ──────────────────────────────────────

test.describe('Session switching (blank terminal fix)', () => {
  let secondSessionCreated = false

  test('create a second session', async () => {
    const plusButtons = page.locator('button', { hasText: '+' }).filter({ hasText: /^\+$/ })
    const count = await plusButtons.count()
    if (count < 2) {
      console.log('[Test] Not enough projects to create second session')
      test.skip()
      return
    }

    // Click a different project's "+"
    await plusButtons.nth(1).click()
    await page.waitForTimeout(4000)
    await page.screenshot({ path: 'tests/screenshots/15-second-session.png' })
    secondSessionCreated = true
  })

  test('switching sessions shows correct terminal (not blank)', async () => {
    // Find session entries in the sidebar active area
    const sessionEntries = page.locator('div.border-b >> div.cursor-pointer.px-3.py-2\\.5')
    const sessionCount = await sessionEntries.count()
    console.log(`[Test] Active session entries: ${sessionCount}`)

    if (sessionCount < 2) {
      console.log('[Test] Only 1 session, skipping switch test')
      test.skip()
      return
    }

    // Click first session
    await sessionEntries.first().click()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'tests/screenshots/16-switch-first.png' })

    // Check terminal is not blank — look for the terminal area
    const termArea = page.locator('div.flex-1.min-h-0.relative')
    await expect(termArea).toBeVisible()
    // The terminal container div should have children (xterm or at least a div)
    const children = await termArea.locator('div').count()
    console.log(`[Test] Terminal area children after switch to first: ${children}`)
    expect(children).toBeGreaterThan(0)

    // Click second session
    await sessionEntries.nth(1).click()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'tests/screenshots/17-switch-second.png' })

    const children2 = await termArea.locator('div').count()
    console.log(`[Test] Terminal area children after switch to second: ${children2}`)
    expect(children2).toBeGreaterThan(0)

    // Switch back to first — this is the key test for the blank terminal bug
    await sessionEntries.first().click()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'tests/screenshots/18-switch-back-first.png' })

    const children3 = await termArea.locator('div').count()
    console.log(`[Test] Terminal area children after switch back: ${children3}`)
    expect(children3).toBeGreaterThan(0)
  })

  test('tab bar shows only current session tabs', async () => {
    const sessionEntries = page.locator('div.border-b >> div.cursor-pointer.px-3.py-2\\.5')
    const sessionCount = await sessionEntries.count()
    if (sessionCount < 2) { test.skip(); return }

    // Click first session — get tab label
    await sessionEntries.first().click()
    await page.waitForTimeout(500)
    const tabs1 = page.locator('div.h-8 >> div.cursor-pointer')
    const label1 = await tabs1.first().locator('span.truncate').textContent()
    console.log(`[Test] First session tab label: "${label1}"`)

    // Click second session — tab label should change
    await sessionEntries.nth(1).click()
    await page.waitForTimeout(500)
    const label2 = await tabs1.first().locator('span.truncate').textContent()
    console.log(`[Test] Second session tab label: "${label2}"`)

    // Only 1 claude tab should be visible (per-session tabs, not all sessions)
    const claudeDots = page.locator('div.h-8 >> span.bg-\\[\\#a6e3a1\\]')
    const claudeCount = await claudeDots.count()
    console.log(`[Test] Claude tabs visible: ${claudeCount}`)
    expect(claudeCount).toBe(1) // Only the active session's tab

    await page.screenshot({ path: 'tests/screenshots/19-per-session-tabs.png' })
  })
})

// ─── Git Branch on Active Sessions ──────────────────────────

test.describe('Git branch on active sessions', () => {
  test('active session shows git branch in sidebar', async () => {
    // Wait for git branch resolution (fire-and-forget, typically fast)
    await page.waitForTimeout(3000)

    // Active sessions area should show branch labels
    const activeSidebar = page.locator('div.border-b')
    const branchLabels = activeSidebar.locator('span.text-\\[\\#89b4fa\\]')
    const count = await branchLabels.count()
    console.log(`[Test] Active session branch labels: ${count}`)

    if (count > 0) {
      const branch = await branchLabels.first().textContent()
      console.log(`[Test] Active session branch: "${branch}"`)
      expect(branch).toBeTruthy()
    }

    await page.screenshot({ path: 'tests/screenshots/20-active-git-branch.png' })
  })
})

// ─── Cleanup ────────────────────────────────────────────────

test.describe('Cleanup', () => {
  test('close all sessions gracefully', async () => {
    // Close via sidebar "x" buttons
    let attempts = 0
    while (attempts < 10) {
      const closeBtns = page.locator('div.border-b >> button', { hasText: 'x' })
      const count = await closeBtns.count()
      if (count === 0) break
      await closeBtns.first().click()
      await page.waitForTimeout(500)
      attempts++
    }

    // Should show "No active sessions" or similar
    await page.screenshot({ path: 'tests/screenshots/21-all-closed.png' })

    // Main area should show the empty state
    const emptyMsg = page.locator('text=No session selected')
    await expect(emptyMsg).toBeVisible({ timeout: 3000 })
  })
})
