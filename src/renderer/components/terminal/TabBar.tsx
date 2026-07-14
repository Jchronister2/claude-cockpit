import React, { useState, useRef, useCallback } from 'react'
import type { TabInfo } from '../../../shared/types'

interface TabBarProps {
  tabs: TabInfo[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onNewTerminal: () => void
  onRenameTab: (tabId: string, newLabel: string) => void
}

export default function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onNewTerminal, onRenameTab }: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEditing = useCallback((tabId: string, currentLabel: string) => {
    setEditingId(tabId)
    setEditValue(currentLabel)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [])

  const commitEdit = useCallback(() => {
    if (editingId && editValue.trim()) {
      onRenameTab(editingId, editValue.trim())
    }
    setEditingId(null)
  }, [editingId, editValue, onRenameTab])

  if (tabs.length === 0) return null

  return (
    <div className="h-8 bg-[#181825] border-b border-[#313244] flex items-center overflow-x-auto select-none">
      {tabs.map(tab => (
        <div
          key={tab.id}
          onClick={() => onSelectTab(tab.id)}
          onDoubleClick={() => startEditing(tab.id, tab.label)}
          className={`flex items-center gap-1.5 px-3 h-full cursor-pointer text-[11px] border-r border-[#313244] min-w-0 max-w-[180px] transition-colors ${
            activeTabId === tab.id
              ? 'bg-[#1e1e2e] text-[#cdd6f4]'
              : 'text-[#6c7086] hover:text-[#a6adc8] hover:bg-[#1e1e2e]/50'
          }`}
        >
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
            tab.type === 'claude' ? 'bg-[#a6e3a1]' : 'bg-[#6c7086]'
          }`} />
          {editingId === tab.id ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={e => {
                if (e.key === 'Enter') commitEdit()
                if (e.key === 'Escape') setEditingId(null)
              }}
              className="bg-transparent text-[#cdd6f4] text-[11px] outline-none border-b border-[#89b4fa] w-full min-w-[40px]"
              autoFocus
            />
          ) : (
            <span className="truncate">{tab.label}</span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
            className="text-[#6c7086] hover:text-[#f38ba8] text-[10px] flex-shrink-0 ml-auto transition-colors"
          >
            x
          </button>
        </div>
      ))}
      <button
        onClick={onNewTerminal}
        className="px-2 h-full text-[#6c7086] hover:text-[#89b4fa] text-sm transition-colors flex-shrink-0"
        title="New terminal"
      >
        +
      </button>
    </div>
  )
}
