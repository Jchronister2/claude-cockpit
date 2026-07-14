export const IPC = {
  // Session discovery (renderer -> main)
  DISCOVER_SESSIONS: 'sessions:discover',

  // Session lifecycle (renderer -> main)
  SESSION_CREATE: 'session:create',
  SESSION_RESUME: 'session:resume',
  SESSION_DESTROY: 'session:destroy',
  SESSION_LIST: 'session:list',
  SESSION_SELECT: 'session:select',
  SESSION_RENAME: 'session:rename',

  // PTY communication
  PTY_WRITE: 'pty:write',
  PTY_DATA: 'pty:data',
  PTY_RESIZE: 'pty:resize',
  PTY_EXIT: 'pty:exit',

  // Context menu (renderer -> main)
  SHOW_PROJECT_MENU: 'menu:show-project',
  SHOW_SESSION_MENU: 'menu:show-session',
  SHOW_ACTIVE_SESSION_MENU: 'menu:show-active-session',

  // State detection (main -> renderer)
  SESSION_STATE_CHANGED: 'session:state-changed',
  SESSION_GIT_BRANCH_CHANGED: 'session:git-branch-changed',

  // PTY scrollback replay
  PTY_SCROLLBACK: 'pty:scrollback',

  // Terminal tabs
  TERMINAL_TAB_CREATE: 'terminal-tab:create',
  TERMINAL_TAB_DESTROY: 'terminal-tab:destroy',
  TERMINAL_TAB_LIST: 'terminal-tab:list',
  TERMINAL_TAB_UPDATE_CWD: 'terminal-tab:update-cwd',
  TERMINAL_TAB_CWD_CHANGED: 'terminal-tab:cwd-changed',

  // Browser window
  BROWSER_OPEN: 'browser:open',
  BROWSER_SESSION_SWITCHED: 'browser:session-switched',
  BROWSER_LOAD_TABS: 'browser:load-tabs',
  BROWSER_TAB_CREATE: 'browser:tab-create',
  BROWSER_TAB_CLOSE: 'browser:tab-close',
  BROWSER_TAB_UPDATE: 'browser:tab-update',
  BROWSER_URL_DETECTED: 'browser:url-detected',

  // Browser profiles
  BROWSER_PROFILE_LIST: 'browser:profile-list',
  BROWSER_PROFILE_SELECT: 'browser:profile-select',
  BROWSER_PROFILE_GET_ACTIVE: 'browser:profile-get-active',
  BROWSER_PROFILE_CHANGED: 'browser:profile-changed',
  BROWSER_PROFILE_IMPORT_COOKIES: 'browser:profile-import-cookies',
  BROWSER_COOKIE_BRIDGE_STATUS: 'browser:cookie-bridge-status',
} as const
