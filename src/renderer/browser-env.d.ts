import type { BrowserAPI } from '../preload/browser'

declare global {
  interface Window {
    browserAPI: BrowserAPI
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string
          allowpopups?: string
          partition?: string
        },
        HTMLElement
      >
    }
  }
}
