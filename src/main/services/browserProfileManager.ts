import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { BrowserProfile } from '../../shared/types'

const PROFILES_FILE = 'browser-profiles.json'

interface PersistedState {
  profiles: BrowserProfile[]
  activeProfileId: string
}

class BrowserProfileManager {
  private profiles: BrowserProfile[] = []
  private activeProfileId = 'default'
  private initialized = false

  init(): void {
    if (this.initialized) return
    this.initialized = true

    // Try to load persisted state first
    const loaded = this.loadState()

    // Discover Chrome profiles and merge
    const chromeProfiles = this.discoverChromeProfiles()

    if (chromeProfiles.length > 0) {
      this.profiles = chromeProfiles
    } else if (!loaded || this.profiles.length === 0) {
      // Fallback: at least a default profile
      this.profiles = [{ id: 'default', name: 'Default', partition: 'persist:profile-default' }]
    }

    // Ensure active profile still exists
    if (!this.profiles.find(p => p.id === this.activeProfileId)) {
      this.activeProfileId = this.profiles[0].id
    }

    this.saveState()
    console.log(`[ProfileManager] Loaded ${this.profiles.length} profiles, active: ${this.activeProfileId}`)
  }

  private discoverChromeProfiles(): BrowserProfile[] {
    const localAppData = process.env['LOCALAPPDATA']
    if (!localAppData) return []

    const localStatePath = join(localAppData, 'Google', 'Chrome', 'User Data', 'Local State')
    if (!existsSync(localStatePath)) {
      console.log('[ProfileManager] Chrome Local State not found:', localStatePath)
      return []
    }

    try {
      const raw = readFileSync(localStatePath, 'utf-8')
      const localState = JSON.parse(raw)
      const infoCache = localState?.profile?.info_cache
      if (!infoCache || typeof infoCache !== 'object') return []

      const profiles: BrowserProfile[] = []

      for (const [dirName, info] of Object.entries(infoCache) as [string, any][]) {
        const name = info?.name || dirName
        // Normalize directory name to a safe id
        const id = dirName.toLowerCase().replace(/\s+/g, '-')
        profiles.push({
          id,
          name,
          partition: `persist:profile-${id}`,
          chromeDir: dirName
        })
      }

      // Sort alphabetically by name
      profiles.sort((a, b) => a.name.localeCompare(b.name))
      console.log(`[ProfileManager] Discovered ${profiles.length} Chrome profiles`)
      return profiles
    } catch (e) {
      console.warn('[ProfileManager] Failed to read Chrome profiles:', (e as Error).message)
      return []
    }
  }

  private getStatePath(): string {
    return join(app.getPath('userData'), PROFILES_FILE)
  }

  private loadState(): boolean {
    try {
      const filePath = this.getStatePath()
      if (!existsSync(filePath)) return false
      const raw = readFileSync(filePath, 'utf-8')
      const state: PersistedState = JSON.parse(raw)
      this.profiles = state.profiles || []
      this.activeProfileId = state.activeProfileId || 'default'
      return true
    } catch {
      return false
    }
  }

  private saveState(): void {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const state: PersistedState = {
        profiles: this.profiles,
        activeProfileId: this.activeProfileId
      }
      writeFileSync(this.getStatePath(), JSON.stringify(state, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[ProfileManager] Failed to save state:', (e as Error).message)
    }
  }

  getProfiles(): BrowserProfile[] {
    return this.profiles
  }

  getActiveProfile(): BrowserProfile | null {
    if (this.profiles.length === 0) return null
    return this.profiles.find(p => p.id === this.activeProfileId) || this.profiles[0]
  }

  selectProfile(id: string): BrowserProfile | null {
    const profile = this.profiles.find(p => p.id === id)
    if (!profile) return null
    this.activeProfileId = id
    this.saveState()
    console.log(`[ProfileManager] Switched to profile: ${profile.name} (${profile.partition})`)
    return profile
  }
}

export const browserProfileManager = new BrowserProfileManager()
