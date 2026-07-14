import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['node-pty']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          browser: resolve('src/preload/browser.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          browser: resolve('src/renderer/browser.html')
        }
      }
    },
    css: {
      postcss: resolve('postcss.config.js')
    }
  }
})
