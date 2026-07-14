import { BrowserWindow } from 'electron'
import { spawn, execSync, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { IPC } from '../../shared/ipcChannels'
import { UrlDetector } from './urlDetector'
import { browserTabManager } from './browserTabManager'
import { createBrowserWindow, getBrowserWindow } from '../windows/browserWindow'

import type { SessionState } from '../../shared/types'

const SCROLLBACK_SIZE = 100_000
const BUSY_CHECK_INTERVAL_MS = 3000  // check data volume every 3s
const BUSY_DATA_THRESHOLD = 200      // bytes per interval to stay busy

interface PtyInstance {
  process: ChildProcess
  sessionId: string
  state: SessionState
  idleTimer: ReturnType<typeof setTimeout> | null
  scrollback: string
  lastDataTime: number
  dataAccum: number  // bytes accumulated since last timer check
  isPlainTerminal: boolean
  cwd?: string       // tracked cwd for plain terminals
}

let nodePty: typeof import('node-pty') | null = null
try {
  nodePty = require('node-pty')
  console.log('[PtyManager] node-pty loaded successfully')
} catch (e) {
  console.warn('[PtyManager] node-pty not available, falling back to child_process:', (e as Error).message)
}

// Build a clean env without Claude Code's nesting-detection variables
function getCleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  delete env['CLAUDECODE']
  delete env['CLAUDE_CODE']
  delete env['CLAUDE_CODE_ENTRY']
  return env
}

export class PtyManager {
  private instances = new Map<string, PtyInstance>()
  private mainWindow: BrowserWindow | null = null
  private urlDetector = new UrlDetector()
  private cwdChangeCallback: ((sessionId: string, cwd: string) => void) | null = null
  private sessionExitCallback: ((sessionId: string, exitCode: number) => void) | null = null

  onCwdChange(callback: (sessionId: string, cwd: string) => void): void {
    this.cwdChangeCallback = callback
  }

  onSessionExit(callback: (sessionId: string, exitCode: number) => void): void {
    this.sessionExitCallback = callback
  }

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  private sendToMain(channel: string, ...args: any[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args)
    }
  }

  private updateState(sessionId: string, newState: SessionState): void {
    const inst = this.instances.get(sessionId)
    if (!inst || inst.state === newState) return
    const prev = inst.state
    inst.state = newState
    console.log(`[State] ${sessionId.slice(0, 8)} ${prev} -> ${newState}`)
    this.sendToMain(IPC.SESSION_STATE_CHANGED, { sessionId, state: newState })
  }

  // Starts a 3s check cycle. When timer fires, checks accumulated data volume:
  // - High data volume → Claude is streaming, stay busy, check again in 3s
  // - Low data volume → TUI maintenance only (permission prompt cursor, etc.), go idle
  private startBusyCheck(sessionId: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    if (inst.idleTimer) clearTimeout(inst.idleTimer)
    inst.dataAccum = 0
    inst.idleTimer = setTimeout(() => {
      console.log(`[State] ${sessionId.slice(0, 8)} timer check: dataAccum=${inst.dataAccum}`)
      if (inst.dataAccum > BUSY_DATA_THRESHOLD) {
        // Substantial data — Claude still streaming, check again
        this.startBusyCheck(sessionId)
      } else {
        // Low data — TUI maintenance only, go idle
        this.updateState(sessionId, 'idle')
      }
    }, BUSY_CHECK_INTERVAL_MS)
  }

  // Accumulates scrollback + tracks data volume for busy detection.
  // Does NOT transition idle → busy (only write() does that).
  private onPtyData(sessionId: string, data: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return

    // Accumulate scrollback for replay on reload
    inst.scrollback += data
    if (inst.scrollback.length > SCROLLBACK_SIZE) {
      inst.scrollback = inst.scrollback.slice(-SCROLLBACK_SIZE)
    }

    inst.lastDataTime = Date.now()

    // For plain terminals: detect cwd from PowerShell prompt (PS C:\path\to\dir>)
    if (inst.isPlainTerminal) {
      // Strip ANSI escape sequences before matching — they can appear inside the prompt
      const clean = data.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b[\x20-\x2f][\x30-\x7e]/g, '')
      const match = clean.match(/PS ([A-Za-z]:\\[^>]*?)>/)
      if (match) {
        // Trim trailing whitespace from the path
        const newCwd = match[1].trimEnd()
        if (newCwd !== inst.cwd) {
          console.log(`[PtyManager] CWD detected for ${sessionId.slice(0, 8)}: "${inst.cwd}" -> "${newCwd}"`)
          inst.cwd = newCwd
          this.cwdChangeCallback?.(sessionId, newCwd)
          this.sendToMain(IPC.TERMINAL_TAB_CWD_CHANGED, { sessionId, cwd: newCwd })
        }
      }
      return
    }

    // Track data volume — checked by startBusyCheck timer
    if (inst.state === 'busy') {
      inst.dataAccum += data.length
    }

    // Detect actionable URLs (localhost, dev servers) and send to browser if open
    const newUrls = this.urlDetector.detect(sessionId, data)
    for (const url of newUrls) {
      const tab = browserTabManager.createTab(sessionId, url)
      if (!tab) continue // Already have a tab for this URL
      console.log(`[UrlDetector] ${sessionId.slice(0, 8)} detected: ${url}`)
      const bWin = getBrowserWindow()
      if (bWin && !bWin.isDestroyed()) {
        bWin.webContents.send(IPC.BROWSER_URL_DETECTED, { sessionId, tab })
        bWin.focus()
      }
    }
  }

  create(
    sessionId: string,
    command: string,
    args: string[],
    cwd: string,
    cols: number,
    rows: number
  ): void {
    if (!existsSync(cwd)) {
      console.warn(`[PtyManager] cwd does not exist: ${cwd}`)
      this.sendToMain(IPC.PTY_DATA, {
        sessionId,
        data: `\r\n\x1b[31mError: Project folder does not exist: ${cwd}\x1b[0m\r\n`
      })
      this.sendToMain(IPC.PTY_EXIT, { sessionId, exitCode: 1 })
      return
    }

    if (nodePty) {
      this.createWithPty(sessionId, command, args, cwd, cols, rows)
    } else {
      this.createWithChildProcess(sessionId, command, args, cwd)
    }
  }

  private createWithPty(
    sessionId: string,
    command: string,
    args: string[],
    cwd: string,
    cols: number,
    rows: number
  ): void {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const shellArgs = process.platform === 'win32'
      ? ['-NoLogo', '-Command', [command, ...args].join(' ')]
      : ['-c', [command, ...args].join(' ')]

    const pty = nodePty!.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: getCleanEnv()
    })

    pty.onData((data: string) => {
      this.sendToMain(IPC.PTY_DATA, { sessionId, data })
      this.onPtyData(sessionId, data)
    })

    pty.onExit(({ exitCode }) => {
      const inst = this.instances.get(sessionId)
      if (inst && !inst.isPlainTerminal) {
        this.sendToMain(IPC.SESSION_STATE_CHANGED, { sessionId, state: 'error' })
        this.sessionExitCallback?.(sessionId, exitCode)
      }
      this.sendToMain(IPC.PTY_EXIT, { sessionId, exitCode })
      this.instances.delete(sessionId)
    })

    this.instances.set(sessionId, {
      process: pty as unknown as ChildProcess,
      sessionId,
      state: 'idle',
      idleTimer: null,
      scrollback: '',
      lastDataTime: 0,
      dataAccum: 0,
      isPlainTerminal: false
    })
  }

  private createWithChildProcess(
    sessionId: string,
    command: string,
    args: string[],
    cwd: string
  ): void {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const shellArgs = process.platform === 'win32'
      ? ['-NoLogo', '-Command', [command, ...args].join(' ')]
      : ['-c', [command, ...args].join(' ')]

    const child = spawn(shell, shellArgs, {
      cwd,
      env: { ...getCleanEnv(), TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    child.stdout?.on('data', (data: Buffer) => {
      const str = data.toString()
      this.sendToMain(IPC.PTY_DATA, { sessionId, data: str })
      this.onPtyData(sessionId, str)
    })

    child.stderr?.on('data', (data: Buffer) => {
      const str = data.toString()
      this.sendToMain(IPC.PTY_DATA, { sessionId, data: str })
      this.onPtyData(sessionId, str)
    })

    child.on('exit', (exitCode) => {
      const inst = this.instances.get(sessionId)
      if (inst && !inst.isPlainTerminal) {
        this.sendToMain(IPC.SESSION_STATE_CHANGED, { sessionId, state: 'error' })
        this.sessionExitCallback?.(sessionId, exitCode ?? 1)
      }
      this.sendToMain(IPC.PTY_EXIT, {
        sessionId,
        exitCode: exitCode ?? 1
      })
      this.instances.delete(sessionId)
    })

    this.instances.set(sessionId, { process: child, sessionId, state: 'idle', idleTimer: null, scrollback: '', lastDataTime: 0, dataAccum: 0, isPlainTerminal: false })
  }

  createPlainTerminal(sessionId: string, cwd: string, cols: number, rows: number): void {
    if (!existsSync(cwd)) {
      console.warn(`[PtyManager] cwd does not exist for terminal: ${cwd}`)
      return
    }

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const shellArgs = process.platform === 'win32' ? ['-NoLogo'] : []

    if (nodePty) {
      let pty: ReturnType<typeof nodePty.spawn>
      try {
        pty = nodePty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: getCleanEnv()
        })
      } catch (err) {
        console.warn(`[PtyManager] Failed to create plain terminal in ${cwd}:`, (err as Error).message)
        return
      }

      pty.onData((data: string) => {
        this.sendToMain(IPC.PTY_DATA, { sessionId, data })
        this.onPtyData(sessionId, data)
      })

      pty.onExit(({ exitCode }) => {
        this.sendToMain(IPC.PTY_EXIT, { sessionId, exitCode })
        this.instances.delete(sessionId)
      })

      this.instances.set(sessionId, {
        process: pty as unknown as ChildProcess,
        sessionId,
        state: 'idle',
        idleTimer: null,
        scrollback: '',
        lastDataTime: 0,
        dataAccum: 0,
        isPlainTerminal: true,
        cwd
      })
    } else {
      const child = spawn(shell, shellArgs, {
        cwd,
        env: { ...getCleanEnv(), TERM: 'xterm-256color' },
        stdio: ['pipe', 'pipe', 'pipe']
      })

      child.stdout?.on('data', (data: Buffer) => {
        const str = data.toString()
        this.sendToMain(IPC.PTY_DATA, { sessionId, data: str })
        this.onPtyData(sessionId, str)
      })

      child.stderr?.on('data', (data: Buffer) => {
        const str = data.toString()
        this.sendToMain(IPC.PTY_DATA, { sessionId, data: str })
        this.onPtyData(sessionId, str)
      })

      child.on('exit', (exitCode) => {
        this.sendToMain(IPC.PTY_EXIT, { sessionId, exitCode: exitCode ?? 1 })
        this.instances.delete(sessionId)
      })

      this.instances.set(sessionId, {
        process: child,
        sessionId,
        state: 'idle',
        idleTimer: null,
        scrollback: '',
        lastDataTime: 0,
        dataAccum: 0,
        isPlainTerminal: true,
        cwd
      })
    }
  }

  // Focus in/out sequences sent by xterm.js when DECSET 1004 is active.
  // These are protocol responses, not user input.
  private isFocusEvent(data: string): boolean {
    return data === '\x1b[I' || data === '\x1b[O'
  }

  write(sessionId: string, data: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return

    // Only trigger busy for real user input, not focus event sequences
    // Plain terminals don't need busy/idle tracking
    if (!inst.isPlainTerminal && !this.isFocusEvent(data)) {
      if (inst.state !== 'busy') {
        console.log(`[State] ${sessionId.slice(0, 8)} write() triggered busy`)
        this.updateState(sessionId, 'busy')
      }
      this.startBusyCheck(sessionId)
    }

    // Always forward to PTY (Claude Code may use focus events)
    if (nodePty) {
      (inst.process as any).write(data)
    } else {
      inst.process.stdin?.write(data)
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!nodePty) return
    const inst = this.instances.get(sessionId)
    if (inst) {
      (inst.process as any).resize(cols, rows)
    }
  }

  destroy(sessionId: string): void {
    const inst = this.instances.get(sessionId)
    if (inst) {
      if (inst.idleTimer) clearTimeout(inst.idleTimer)
      const pid = (inst.process as any).pid
      console.log(`[PtyManager] Destroying ${sessionId.slice(0, 8)}, PID: ${pid}, isPlain: ${inst.isPlainTerminal}`)
      // Kill entire process tree so child processes (ng serve, postgres, etc.) don't linger
      if (process.platform === 'win32' && pid) {
        // Kill entire process tree — try multiple strategies
        // 1. node-pty kill (sends CTRL_C then terminates)
        try {
          if (nodePty) (inst.process as any).kill()
          else inst.process.kill()
        } catch { /* ignore */ }
        // 2. taskkill the process tree by PID
        try {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 })
          console.log(`[PtyManager] taskkill /F /T /PID ${pid} succeeded`)
        } catch (err) {
          const msg = (err as any)?.stderr || (err as Error).message
          console.log(`[PtyManager] taskkill PID ${pid} failed: ${msg}`)
        }
      } else if (nodePty) {
        (inst.process as any).kill()
      } else {
        inst.process.kill()
      }
      this.instances.delete(sessionId)
    }
    this.urlDetector.clearSession(sessionId)
  }

  destroyAll(): void {
    for (const [id] of this.instances) {
      this.destroy(id)
    }
  }

  has(sessionId: string): boolean {
    return this.instances.has(sessionId)
  }

  getScrollback(sessionId: string): string {
    return this.instances.get(sessionId)?.scrollback ?? ''
  }

  getState(sessionId: string): SessionState {
    return this.instances.get(sessionId)?.state ?? 'idle'
  }

  getCwd(sessionId: string): string | undefined {
    return this.instances.get(sessionId)?.cwd
  }
}
