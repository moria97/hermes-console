import {
  FolderOpen,
  MessageSquare,
  Settings as SettingsIcon,
  Terminal as TerminalIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, HealthInfo, HermesVersion } from './api'
import ChatTab from './tabs/ChatTab'
import FilesTab from './tabs/FilesTab'
import SettingsTab from './tabs/SettingsTab'
import TerminalTab from './tabs/TerminalTab'

type TabKey = 'chat' | 'files' | 'terminal' | 'settings'

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { key: 'chat', label: '聊天', icon: MessageSquare },
  { key: 'files', label: '文件', icon: FolderOpen },
  { key: 'terminal', label: '终端', icon: TerminalIcon },
  { key: 'settings', label: '快速设置', icon: SettingsIcon },
]

export default function App() {
  // null while we're deciding the initial tab — avoids a chat→settings flicker
  // for first-run users who land directly on the Settings tab.
  const [active, setActive] = useState<TabKey | null>(null)
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [version, setVersion] = useState<HermesVersion | null>(null)

  useEffect(() => {
    const tick = () => api.health().then(setHealth).catch(() => setHealth(null))
    tick()
    const id = setInterval(tick, 10000)
    return () => clearInterval(id)
  }, [])

  // Hermes version is cached server-side; fetch once on mount.
  useEffect(() => {
    api.version().then(setVersion).catch(() => setVersion(null))
  }, [])

  // Pick the initial tab based on whether the user has any model providers
  // configured: empty → drop them on 快速设置 to add one, otherwise → 聊天.
  useEffect(() => {
    api
      .getSettings()
      .then((s) => setActive(s.providers.length === 0 ? 'settings' : 'chat'))
      .catch(() => setActive('chat'))
  }, [])

  const gatewayState =
    !health ? 'bad' : health.gateway === 'ok' ? 'ok' : 'warn'
  const gatewayText = !health
    ? '后端不可达'
    : health.gateway === 'ok'
      ? 'Gateway 在线'
      : `Gateway ${health.gateway}`

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark-img" src="/favicon.ico" alt="Hermes" />
          <span className="brand-text">Hermes Console</span>
          {/* Always render the badge so layout doesn't jump when /api/console/
             version resolves. Show an em-dash placeholder while loading. */}
          <span
            className={`brand-version ${version?.version ? '' : 'is-placeholder'}`}
            title={
              version?.version
                ? version.build
                  ? `hermes-agent ${version.version} · build ${version.build}`
                  : `hermes-agent ${version.version}`
                : '正在读取 hermes-agent 版本…'
            }
          >
            {version?.version || '—'}
          </span>
        </div>

        <nav className="tabs">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.key}
                className={`tab-btn ${active === t.key ? 'active' : ''}`}
                onClick={() => setActive(t.key)}
              >
                <Icon size={15} />
                {t.label}
              </button>
            )
          })}
        </nav>

        <div className="status-pill">
          <span className={`status-dot ${gatewayState === 'ok' ? '' : gatewayState}`} />
          {gatewayText}
        </div>
      </header>

      <main className="panes">
        <div className="pane" hidden={active !== 'chat'}>
          <ChatTab onNavigateToSettings={() => setActive('settings')} />
        </div>
        <div className="pane" hidden={active !== 'files'}>
          <FilesTab />
        </div>
        <div className="pane" hidden={active !== 'terminal'}>
          <TerminalTab visible={active === 'terminal'} />
        </div>
        <div className="pane" hidden={active !== 'settings'}>
          <SettingsTab onNavigateToTerminal={() => setActive('terminal')} />
        </div>
      </main>
    </div>
  )
}
