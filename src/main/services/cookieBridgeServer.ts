import { timingSafeEqual } from 'crypto'
import http from 'http'
import { session } from 'electron'
import { browserProfileManager } from './browserProfileManager'

const PORT = 48721
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_COOKIES = 10_000

let server: http.Server | null = null
let lastSyncTime = 0
let lastCookieCount = 0

export interface BridgeSyncResult {
  imported: number
  skipped: number
  total: number
}

function configuredToken(): string | null {
  const token = process.env['COCKPIT_COOKIE_BRIDGE_TOKEN']?.trim() ?? ''
  return token.length >= 32 ? token : null
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
  const expectedBuffer = Buffer.from(token)
  const suppliedBuffer = Buffer.from(supplied)
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer)
}

function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin
  if (origin && !origin.startsWith('chrome-extension://')) return false
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  return true
}

export function startCookieBridge(): void {
  if (server) return
  const token = configuredToken()
  if (!token) {
    console.warn('[CookieBridge] Disabled. Set COCKPIT_COOKIE_BRIDGE_TOKEN to a value of at least 32 characters to enable it.')
    return
  }

  server = http.createServer(async (req, res) => {
    if (!setCorsHeaders(req, res)) {
      res.writeHead(403)
      res.end('Forbidden origin')
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (!authorized(req, token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    if (req.method === 'GET' && req.url === '/ping') {
      const profile = browserProfileManager.getActiveProfile()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ready',
        profile: profile?.name ?? null,
        lastSync: lastSyncTime,
        lastCookieCount
      }))
      return
    }

    if (req.method === 'POST' && req.url === '/cookies') {
      let body = ''
      let receivedBytes = 0
      req.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length
        if (receivedBytes > MAX_BODY_BYTES) req.destroy()
        else body += chunk.toString('utf8')
      })
      req.on('end', async () => {
        try {
          const cookies = JSON.parse(body)
          if (!Array.isArray(cookies) || cookies.length > MAX_COOKIES) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `Expected an array of at most ${MAX_COOKIES} cookies` }))
            return
          }

          const result = await importCookiesIntoSession(cookies)
          lastSyncTime = Date.now()
          lastCookieCount = cookies.length
          console.log(`[CookieBridge] Received ${cookies.length} cookies; imported=${result.imported}, skipped=${result.skipped}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (error) {
          console.error('[CookieBridge] Error processing cookies:', (error as Error).message)
          if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid cookie payload' }))
        }
      })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CookieBridge] Listening on http://127.0.0.1:${PORT}`)
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error('[CookieBridge] Server error:', error.message)
  })
}

export function stopCookieBridge(): void {
  server?.close()
  server = null
}

export function getBridgeStatus(): { running: boolean; lastSync: number; lastCookieCount: number } {
  return {
    running: server !== null && server.listening,
    lastSync: lastSyncTime,
    lastCookieCount
  }
}

function mapSameSite(value: string): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  switch (value) {
    case 'no_restriction': return 'no_restriction'
    case 'lax': return 'lax'
    case 'strict': return 'strict'
    default: return 'unspecified'
  }
}

function validCookie(cookie: unknown): cookie is Record<string, any> {
  if (!cookie || typeof cookie !== 'object') return false
  const candidate = cookie as Record<string, unknown>
  return typeof candidate.name === 'string' &&
    typeof candidate.value === 'string' &&
    typeof candidate.domain === 'string' &&
    candidate.domain.length > 0 &&
    candidate.domain.length <= 253 &&
    !candidate.domain.includes('/') &&
    typeof candidate.path === 'string'
}

async function importCookiesIntoSession(cookies: unknown[]): Promise<BridgeSyncResult> {
  const profile = browserProfileManager.getActiveProfile()
  if (!profile) return { imported: 0, skipped: cookies.length, total: cookies.length }

  const browserSession = session.fromPartition(profile.partition)
  let imported = 0
  let skipped = 0

  await Promise.all(cookies.map(async (cookie) => {
    if (!validCookie(cookie)) {
      skipped++
      return
    }

    const scheme = cookie.secure ? 'https' : 'http'
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
    const details: Electron.CookiesSetDetails = {
      url: `${scheme}://${domain}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: mapSameSite(String(cookie.sameSite ?? ''))
    }
    if (typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0) {
      details.expirationDate = cookie.expirationDate
    }

    try {
      await browserSession.cookies.set(details)
      imported++
    } catch {
      skipped++
    }
  }))

  return { imported, skipped, total: cookies.length }
}
