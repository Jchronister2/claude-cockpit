import { app } from 'electron'
import path from 'path'
import fs from 'fs'

const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const MAX_LOG_SIZE = 5 * 1024 * 1024 // 5MB per file

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

function getLogFile(): string {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return path.join(LOG_DIR, `cockpit-${date}.log`)
}

function rotateIfNeeded(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath)
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = filePath.replace('.log', `-${Date.now()}.log`)
        fs.renameSync(filePath, rotated)
      }
    }
  } catch { /* ignore */ }
}

function formatTimestamp(): string {
  return new Date().toISOString()
}

export function log(category: string, message: string, data?: Record<string, unknown>): void {
  ensureLogDir()
  const file = getLogFile()
  rotateIfNeeded(file)

  const line = data
    ? `[${formatTimestamp()}] [${category}] ${message} ${JSON.stringify(data)}\n`
    : `[${formatTimestamp()}] [${category}] ${message}\n`

  // Write to file
  try {
    fs.appendFileSync(file, line, 'utf-8')
  } catch { /* ignore */ }

  // Also write to console for dev mode
  console.log(`[${category}] ${message}`, data ? JSON.stringify(data) : '')
}

export function getLogPath(): string {
  return LOG_DIR
}
