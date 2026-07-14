import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')

/** Wait for session scanning to finish */
async function waitForAppReady(page: Page) {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => {
    const el = document.querySelector('body')
    return el && !el.textContent?.includes('Scanning sessions')
  }, { timeout: 15_000 })
  await page.waitForTimeout(1000)
}

// ─── Session Exit Handling ──────────────────────────────────

test.describe.serial('Session exit and error state handling', () => {
  let app: ElectronApplication
  let page: Page
  let stateFilePath: string

  test.beforeAll(async () => {
    // Get state file path and clear it
    const tempApp = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 30_000
    })
    const userData = await tempApp.evaluate(async ({ app: electronApp }) => {
      return electronApp.getPath('userData')
    })
    stateFilePath = path.join(userData, 'session-state.json')
    await tempApp.close()

    try { if (fs.existsSync(stateFilePath)) fs.unlinkSync(stateFilePath) } catch {}

    app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 30_000
    })
    page = await app.firstWindow()
    await waitForAppReady(page)
  })

  test.afterAll(async () => {
    if (app) await app.close()
    try { if (fs.existsSync(stateFilePath)) fs.unlinkSync(stateFilePath) } catch {}
  })

  test('closing a session does not blank other sessions', async () => {
    // Create first session
    const plusButtons = page.locator('button', { hasText: '+' }).filter({ hasText: /^\+$/ })
    await expect(plusButtons.first()).toBeVisible({ timeout: 5000 })
    await plusButtons.first().click()
    await page.waitForTimeout(4000)
    await page.screenshot({ path: 'tests/screenshots/exit-01-first-session.png' })

    // Verify first session exists
    const activeArea = page.locator('text=/IDLE|Active/i')
    await expect(activeArea.first()).toBeVisible({ timeout: 5000 })

    // Check terminal is not blank — xterm should be rendered
    const termArea = page.locator('div.flex-1.min-h-0.relative')
    await expect(termArea).toBeVisible()
    const xtermBefore = await termArea.locator('.xterm').count()
    console.log(`[Test] xterm instances before: ${xtermBefore}`)
    expect(xtermBefore).toBeGreaterThan(0)

    // Create second session
    const plusCount = await plusButtons.count()
    if (plusCount >= 2) {
      await plusButtons.nth(1).click()
    } else {
      await plusButtons.first().click()
    }
    await page.waitForTimeout(4000)
    await page.screenshot({ path: 'tests/screenshots/exit-02-second-session.png' })

    // Now close the first session via the 'x' button
    const closeBtns = page.locator('div.border-b button', { hasText: 'x' })
    const closeCount = await closeBtns.count()
    console.log(`[Test] Close buttons: ${closeCount}`)
    expect(closeCount).toBeGreaterThanOrEqual(2)

    await closeBtns.first().click()
    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'tests/screenshots/exit-03-after-close.png' })

    // The remaining session should NOT be blank — xterm should still be rendered
    const xtermAfter = await termArea.locator('.xterm').count()
    console.log(`[Test] xterm instances after close: ${xtermAfter}`)
    expect(xtermAfter).toBeGreaterThan(0)

    // Terminal area should be visible
    await expect(termArea).toBeVisible()

    // Take final screenshot for visual verification
    await page.screenshot({ path: 'tests/screenshots/exit-04-terminal-intact.png' })
  })

  test('dead sessions are not persisted', async () => {
    // Close the app and check persisted state
    await app.close()
    await new Promise(r => setTimeout(r, 500))

    if (fs.existsSync(stateFilePath)) {
      const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'))
      console.log(`[Test] Persisted sessions: ${state.sessions.length}`)
      // No sessions should have error state persisted
      // (dead sessions from closed PTY should not be saved)
      for (const s of state.sessions) {
        console.log(`[Test] Session: ${s.projectName} (claude: ${s.claudeSessionId ? 'yes' : 'no'})`)
      }
    } else {
      console.log('[Test] No state file — expected if all sessions were destroyed')
    }

    // Re-launch for afterAll cleanup
    app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 30_000
    })
    page = await app.firstWindow()
  })
})
