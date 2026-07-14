import React from 'react'
import { createRoot } from 'react-dom/client'
import BrowserApp from './BrowserApp'
import './styles/globals.css'

const root = document.getElementById('root')!
createRoot(root).render(<BrowserApp />)
