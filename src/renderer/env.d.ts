import type { ElectronAPI } from '../preload/index'
import type { BrowserAPI } from '../preload/browser'

declare global {
  interface Window {
    electronAPI: ElectronAPI
    browserAPI: BrowserAPI
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
        allowpopups?: string
      }
    }
  }
}
