// Strips ANSI escape sequences from PTY output — replaces with a space
// so that adjacent tokens don't fuse (e.g. "login\x1b[0m-H" → "login -H" not "login-H")
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b[\x20-\x2f][\x30-\x7e]/g

// Matches http/https URLs — broad capture, refined by isActionableUrl
const URL_RE = /https?:\/\/[^\s"'<>\])\x00-\x1f]+/g

// Trailing buffer size to handle URLs split across PTY chunks
const TRAIL_SIZE = 200

/**
 * Determines if a URL is "actionable" — something the user likely wants opened.
 * Only opens localhost, 127.0.0.1, 0.0.0.0, or URLs with non-standard ports.
 * This avoids auto-opening random docs/GitHub links from Claude's output.
 */
function isActionableUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()

    // localhost / loopback addresses
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
      return true
    }

    // Any URL with a non-standard port (not 80/443)
    if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
      return true
    }

    return false
  } catch {
    return false
  }
}

/** Cleans up trailing junk chars that get captured by the broad regex */
function cleanUrl(raw: string): string {
  return raw
    // Remove trailing punctuation that's not part of URLs
    .replace(/[.,;:!?)]+$/, '')
    // Remove trailing flag-like fragments (e.g. "-H", "-X" from fused curl flags)
    .replace(/-[A-Z]$/, '')
    // Clean again after flag removal
    .replace(/[.,;:!?)]+$/, '')
}

interface SessionBuffer {
  seen: Set<string>
  trailing: string
}

export class UrlDetector {
  private sessions = new Map<string, SessionBuffer>()

  private getSession(sessionId: string): SessionBuffer {
    let buf = this.sessions.get(sessionId)
    if (!buf) {
      buf = { seen: new Set(), trailing: '' }
      this.sessions.set(sessionId, buf)
    }
    return buf
  }

  /**
   * Feed a PTY data chunk. Returns array of newly detected actionable URLs.
   */
  detect(sessionId: string, data: string): string[] {
    const buf = this.getSession(sessionId)

    // Prepend trailing buffer from previous chunk to catch split URLs
    const combined = buf.trailing + data

    // Strip ANSI escape sequences — replace with space to prevent token fusion
    const clean = combined.replace(ANSI_RE, ' ')

    const newUrls: string[] = []

    let match: RegExpExecArray | null
    URL_RE.lastIndex = 0
    while ((match = URL_RE.exec(clean)) !== null) {
      const url = cleanUrl(match[0])
      if (!isActionableUrl(url)) continue
      if (buf.seen.has(url)) continue
      buf.seen.add(url)
      newUrls.push(url)
    }

    // Keep trailing chars for next chunk (URL might be split)
    buf.trailing = clean.length > TRAIL_SIZE ? clean.slice(-TRAIL_SIZE) : clean

    return newUrls
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
