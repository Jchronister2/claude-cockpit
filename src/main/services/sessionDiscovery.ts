import { readdir, readFile, stat } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync } from 'fs'

export interface DiscoveredSession {
  sessionId: string
  projectPath: string
  projectName: string
  summary: string
  firstPrompt: string
  messageCount: number
  created: string
  modified: string
  gitBranch: string
  isRecent: boolean // modified within last 2 hours
}

export interface ProjectGroup {
  projectPath: string
  projectName: string
  sessions: DiscoveredSession[]
}

export async function discoverSessions(): Promise<ProjectGroup[]> {
  const claudeDir = join(homedir(), '.claude', 'projects')
  const groups: ProjectGroup[] = []

  let projectDirs: string[]
  try {
    projectDirs = await readdir(claudeDir)
  } catch {
    return []
  }

  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000

  for (const dir of projectDirs) {
    const dirPath = join(claudeDir, dir)
    const indexPath = join(dirPath, 'sessions-index.json')

    // Try to read the index, but don't skip if it's missing
    let index: { entries: any[]; originalPath?: string } | null = null
    try {
      const raw = await readFile(indexPath, 'utf-8')
      index = JSON.parse(raw)
    } catch {
      // No index or invalid JSON — we'll scan for .jsonl files
    }

    let sessions: DiscoveredSession[]
    let projectPath: string

    if (index?.entries && index.entries.length > 0) {
      // Index has entries — use them as a starting point
      projectPath = index.originalPath || index.entries[0]?.projectPath || decodeDirName(dir)
      const projectName = projectPath.split(/[\\/]/).pop() || dir

      if (!existsSync(projectPath)) continue

      sessions = index.entries.map((e: any) => ({
        sessionId: e.sessionId,
        projectPath: e.projectPath || projectPath,
        projectName,
        summary: e.summary || '',
        firstPrompt: e.firstPrompt || '',
        messageCount: e.messageCount || 0,
        created: e.created || '',
        modified: e.modified || '',
        gitBranch: e.gitBranch || '',
        isRecent: new Date(e.modified).getTime() > twoHoursAgo
      }))

      // Also scan for .jsonl files not in the index (index is often incomplete)
      const indexedIds = new Set(index.entries.map((e: any) => e.sessionId))
      const scanResult = await scanJsonlFiles(dirPath, twoHoursAgo)
      for (const s of scanResult.sessions) {
        if (!indexedIds.has(s.sessionId)) {
          s.projectPath = projectPath
          s.projectName = projectName
          sessions.push(s)
        }
      }
    } else {
      // Index is empty or missing — scan .jsonl files to find real project path
      const scanResult = await scanJsonlFiles(dirPath, twoHoursAgo)
      sessions = scanResult.sessions

      // Prefer index originalPath (Claude's intended project), then cwd from jsonl, then decode dir name
      const decoded = decodeDirName(dir)
      projectPath = index?.originalPath
        || scanResult.detectedPath
        || (existsSync(decoded) ? decoded : '')

      if (!projectPath || !existsSync(projectPath)) continue

      const projectName = projectPath.split(/[\\/]/).pop() || dir
      for (const s of sessions) {
        s.projectPath = projectPath
        s.projectName = projectName
      }
    }

    if (sessions.length === 0) continue

    const projectName = projectPath.split(/[\\/]/).pop() || dir
    sessions.sort((a, b) =>
      new Date(b.modified).getTime() - new Date(a.modified).getTime()
    )

    // Merge into existing group if same projectPath, otherwise create new
    const existing = groups.find(g => g.projectPath === projectPath)
    if (existing) {
      // Deduplicate sessions by sessionId
      const existingIds = new Set(existing.sessions.map(s => s.sessionId))
      for (const s of sessions) {
        if (!existingIds.has(s.sessionId)) {
          existing.sessions.push(s)
        }
      }
    } else {
      groups.push({ projectPath, projectName, sessions })
    }
  }

  // Sort groups by most recently modified session
  groups.sort((a, b) => {
    const aLatest = a.sessions[0]?.modified || ''
    const bLatest = b.sessions[0]?.modified || ''
    return new Date(bLatest).getTime() - new Date(aLatest).getTime()
  })

  return groups
}

interface ScanResult {
  sessions: DiscoveredSession[]
  detectedPath: string // real project path from cwd field in jsonl
}

async function scanJsonlFiles(
  dirPath: string,
  twoHoursAgo: number
): Promise<ScanResult> {
  const sessions: DiscoveredSession[] = []
  let detectedPath = ''

  let files: string[]
  try {
    files = await readdir(dirPath)
  } catch {
    return { sessions, detectedPath }
  }

  const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

  for (const file of jsonlFiles) {
    const sessionId = basename(file, '.jsonl')
    try {
      const content = readFileSync(join(dirPath, file), 'utf-8')
      const lines = content.split('\n').filter(l => l.trim().length > 0)

      let firstPrompt = ''
      let messageCount = 0
      let firstTs = ''
      let lastTs = ''
      let gitBranch = ''

      for (const line of lines) {
        let parsed: any
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }

        // Detect real project path from cwd field
        if (parsed.cwd && !detectedPath) detectedPath = parsed.cwd

        if (parsed.timestamp) {
          if (!firstTs) firstTs = parsed.timestamp
          lastTs = parsed.timestamp
        }

        if (parsed.gitBranch && !gitBranch) gitBranch = parsed.gitBranch

        if (parsed.type === 'user') {
          messageCount++
          if (!firstPrompt && parsed.message && parsed.message.content) {
            const text = typeof parsed.message.content === 'string'
              ? parsed.message.content
              : parsed.message.content.map((c: any) => c.text || '').join('')
            firstPrompt = text.slice(0, 120)
          }
        }
      }

      if (messageCount === 0) continue

      sessions.push({
        sessionId,
        projectPath: '', // filled in by caller
        projectName: '',
        summary: '',
        firstPrompt,
        messageCount,
        created: firstTs,
        modified: lastTs,
        gitBranch,
        isRecent: new Date(lastTs).getTime() > twoHoursAgo
      })
    } catch {
      // Skip unreadable files
    }
  }

  return { sessions, detectedPath }
}

/**
 * Move a session .jsonl (and its companion folder if it exists) to a different
 * project directory inside ~/.claude/projects/. Creates the target project
 * folder + sessions-index.json if they don't exist yet.
 */
export async function moveSession(
  sessionId: string,
  sourceProjectPath: string,
  targetProjectPath: string
): Promise<boolean> {
  const claudeDir = join(homedir(), '.claude', 'projects')
  const jsonlFile = sessionId + '.jsonl'
  const companionDir = sessionId

  const dirs = await readdir(claudeDir)

  // Find the source dir by looking for the actual .jsonl file on disk
  let sourceDirName: string | null = null
  for (const dir of dirs) {
    if (existsSync(join(claudeDir, dir, jsonlFile))) {
      sourceDirName = dir
      break
    }
  }

  if (!sourceDirName) {
    console.warn('[moveSession] Could not find source dir for session', sessionId)
    return false
  }

  const sourceDir = join(claudeDir, sourceDirName)

  // Find or create the target project dir
  let targetDirName: string | null = null
  const expectedTargetDir = encodePathToDir(targetProjectPath)

  // First check if the encoded dir name already exists
  if (dirs.includes(expectedTargetDir)) {
    targetDirName = expectedTargetDir
  } else {
    // Fall back to checking index files for originalPath match
    for (const dir of dirs) {
      const indexPath = join(claudeDir, dir, 'sessions-index.json')
      try {
        const raw = await readFile(indexPath, 'utf-8')
        const index = JSON.parse(raw)
        const origPath = index.originalPath || index.entries?.[0]?.projectPath || ''
        if (origPath === targetProjectPath) {
          targetDirName = dir
          break
        }
      } catch {
        continue
      }
    }
  }

  // Guard: if source and target are the same directory, nothing to do
  if (targetDirName === sourceDirName) {
    console.warn('[moveSession] Source and target are the same directory:', sourceDirName)
    return false
  }

  if (!targetDirName) {
    // Create a new project folder with the encoded path name
    targetDirName = expectedTargetDir
    const targetDir = join(claudeDir, targetDirName)
    const { mkdir, writeFile } = await import('fs/promises')
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'sessions-index.json'), JSON.stringify({
      version: 1,
      entries: [],
      originalPath: targetProjectPath
    }, null, 2))
  }

  const targetDir = join(claudeDir, targetDirName)

  // Move .jsonl file
  const { rename, copyFile, unlink } = await import('fs/promises')
  try {
    await rename(join(sourceDir, jsonlFile), join(targetDir, jsonlFile))
  } catch {
    // rename fails across drives — fall back to copy+delete
    try {
      await copyFile(join(sourceDir, jsonlFile), join(targetDir, jsonlFile))
      await unlink(join(sourceDir, jsonlFile))
    } catch (e) {
      console.error('[moveSession] Failed to move jsonl:', e)
      return false
    }
  }

  // Move companion folder if it exists
  if (existsSync(join(sourceDir, companionDir))) {
    try {
      await rename(join(sourceDir, companionDir), join(targetDir, companionDir))
    } catch {
      // Cross-drive moves of folders are harder; skip for now
      console.warn('[moveSession] Could not move companion folder')
    }
  }

  // Remove from source index if it was there
  try {
    const raw = await readFile(join(sourceDir, 'sessions-index.json'), 'utf-8')
    const index = JSON.parse(raw)
    if (index.entries) {
      index.entries = index.entries.filter((e: any) => e.sessionId !== sessionId)
      const { writeFile } = await import('fs/promises')
      await writeFile(join(sourceDir, 'sessions-index.json'), JSON.stringify(index, null, 2))
    }
  } catch {
    // Index doesn't exist or can't be updated
  }

  console.log('[moveSession] Moved', sessionId, 'from', sourceDirName, 'to', targetDirName)
  return true
}

function encodePathToDir(projectPath: string): string {
  // C:\Users\Foo\Bar → C--Users-Foo-Bar
  return projectPath.replace(/:\\/g, '--').replace(/\\/g, '-').replace(/\//g, '-')
}

function decodeDirName(dir: string): string {
  // C--Users-Foo-Bar → C:\Users\Foo\Bar
  return dir.replace(/^([A-Z])--/, '$1:\\').replace(/-/g, '\\')
}
