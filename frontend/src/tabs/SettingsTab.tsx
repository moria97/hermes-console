import {
  CheckCircle2,
  RefreshCw,
  Save,
  XCircle,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, ConsoleSettings } from '../api'
import Select from '../components/Select'
import { sortModels } from '../lib'

type Section = 'bailian' | 'feishu' | 'dingtalk'

interface BailianPreset {
  id: string
  label: string
  url: string
  // Static model list for endpoints that don't expose /v1/models.
  // null means "dynamic — use /v1/models on refresh".
  staticModels: string[] | null
}

// Plans that don't support /v1/models share this curated fallback list.
const PLAN_MODELS = ['qwen3.6-plus', 'kimi-k2.5', 'glm-5', 'MiniMax-M2.5']

// Stale/deprecated model IDs to hide even if the provider returns them.
const MODEL_DENY = new Set(['qwen3-plus'])

const BAILIAN_PRESETS: BailianPreset[] = [
  {
    id: 'public',
    label: '百炼 API',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    staticModels: null,
  },
  {
    id: 'tokenplan',
    label: 'Token Plan',
    url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    staticModels: PLAN_MODELS,
  },
  {
    id: 'coding',
    label: 'Coding Plan',
    url: 'https://coding.dashscope.aliyuncs.com/v1',
    staticModels: PLAN_MODELS,
  },
  { id: 'custom', label: '自定义', url: '', staticModels: null },
]

const presetFor = (url: string) =>
  BAILIAN_PRESETS.find((p) => p.url === url) ?? BAILIAN_PRESETS[BAILIAN_PRESETS.length - 1]

const DEFAULT: ConsoleSettings = {
  bailian: {
    api_key: '',
    base_url: BAILIAN_PRESETS[0].url,
    default_model: 'qwen3.6-plus',
    enabled: true,
  },
  feishu: { app_id: '', app_secret: '', enabled: false },
  dingtalk: { client_id: '', client_secret: '', enabled: false },
}

export default function SettingsTab() {
  const [section, setSection] = useState<Section>('bailian')
  const [settings, setSettings] = useState<ConsoleSettings>(DEFAULT)
  const [loading, setLoading] = useState(true)
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testOut, setTestOut] = useState<{ ok: boolean; text: string } | null>(null)
  const [modelList, setModelList] = useState<string[]>([])
  const [refreshingModels, setRefreshingModels] = useState(false)

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch(() => setSettings(DEFAULT))
      .finally(() => setLoading(false))
  }, [])

  const setPart = <K extends Section>(key: K, patch: Partial<ConsoleSettings[K]>) =>
    setSettings((s) => ({ ...s, [key]: { ...s[key], ...patch } }))

  const save = async () => {
    try {
      const saved = await api.saveSettings(settings)
      setSettings(saved)
      setSaveMsg({ ok: true, text: '已保存' })
      try {
        const r = await api.reloadGateway()
        setSaveMsg({
          ok: true,
          text: r.reloaded ? '已保存并重载网关' : '已保存（' + (r.hint ?? '重启容器生效') + '）',
        })
      } catch {
        /* ignore */
      }
    } catch (e: any) {
      setSaveMsg({ ok: false, text: `保存失败: ${e.message ?? e}` })
    } finally {
      setTimeout(() => setSaveMsg(null), 4000)
    }
  }

  const test = async () => {
    setTestOut({ ok: true, text: '测试中...' })
    try {
      const r = await api.testBailian(settings.bailian)
      setTestOut({ ok: true, text: `✓ 连接成功\n${r.models.join(', ')}` })
    } catch (e: any) {
      setTestOut({ ok: false, text: `✗ ${e.message ?? e}` })
    }
  }

  const activePreset = presetFor(settings.bailian.base_url)

  // Populate modelList from the preset's static fallback whenever the preset
  // changes. Endpoints with null staticModels (public, custom) leave the list
  // empty until the user clicks refresh.
  useEffect(() => {
    if (activePreset.staticModels) {
      setModelList(sortModels(activePreset.staticModels))
    } else {
      setModelList([])
    }
  }, [activePreset.id])

  const refreshModels = async () => {
    // Plans with a static list just re-populate from the preset; no HTTP call.
    if (activePreset.staticModels) {
      setModelList(sortModels(activePreset.staticModels))
      setTestOut({ ok: true, text: `✓ ${activePreset.label} 内置 ${activePreset.staticModels.length} 个模型（该端点不支持 /v1/models）` })
      return
    }
    if (!settings.bailian.api_key) {
      setTestOut({ ok: false, text: '请先填写 API Key' })
      return
    }
    setRefreshingModels(true)
    try {
      const r = await api.testBailian(settings.bailian)
      const filtered = r.models.filter((m) => !MODEL_DENY.has(m))
      const sorted = sortModels(filtered)
      setModelList(sorted)
      setTestOut({ ok: true, text: `✓ 获取 ${sorted.length} 个模型` })
    } catch (e: any) {
      setTestOut({ ok: false, text: `✗ ${e.message ?? e}` })
    } finally {
      setRefreshingModels(false)
    }
  }

  // Keep the currently-saved default in the dropdown even if it isn't in the
  // fetched/static list (user typed it manually before the endpoint had it).
  const modelOptions = (() => {
    const current = settings.bailian.default_model
    const set = new Set(modelList)
    if (current && !set.has(current)) return [current, ...modelList]
    return modelList
  })()

  if (loading) return <div className="editor-placeholder">加载中…</div>

  const SECTION_META: Record<Section, { label: string; icon: string }> = {
    bailian: { label: '百炼', icon: '/brand/bailian.png' },
    feishu: { label: '飞书', icon: '/brand/feishu.webp' },
    dingtalk: { label: '钉钉', icon: '/brand/dingtalk.webp' },
  }

  return (
    <div className="settings">
      <nav className="settings-nav">
        {(Object.keys(SECTION_META) as Section[]).map((s) => {
          const { label, icon } = SECTION_META[s]
          return (
            <button
              key={s}
              className={section === s ? 'active' : ''}
              onClick={() => setSection(s)}
            >
              <img className="brand-ico" src={icon} alt={label} />
              {label}
            </button>
          )
        })}
      </nav>

      <div className="settings-body">
        {section === 'bailian' && (
          <div className="settings-card">
            <h2>
              <img className="brand-ico lg" src="/brand/bailian.png" alt="百炼" />
              百炼 / DashScope OpenAI 兼容
            </h2>
            <p className="desc">
              配置大语言模型服务端点、API Key 和默认模型。保存后自动写入 hermes 的 config.yaml 并重载网关。
            </p>

            <div className="field">
              <span>API Key</span>
              <input
                type="password"
                value={settings.bailian.api_key}
                onChange={(e) => setPart('bailian', { api_key: e.target.value })}
                placeholder="sk-..."
              />
            </div>

            <div className="field">
              <span>服务端点</span>
              <Select
                value={activePreset.id}
                options={BAILIAN_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                onChange={(v) => {
                  const p = BAILIAN_PRESETS.find((x) => x.id === v)!
                  if (p.id !== 'custom') {
                    setPart('bailian', { base_url: p.url })
                  } else if (
                    BAILIAN_PRESETS.some((x) => x.url === settings.bailian.base_url)
                  ) {
                    setPart('bailian', { base_url: '' })
                  }
                }}
              />
            </div>

            <div className="field">
              <span>Base URL</span>
              <input
                type="text"
                value={settings.bailian.base_url}
                onChange={(e) => setPart('bailian', { base_url: e.target.value })}
                placeholder="https://..."
                readOnly={activePreset.id !== 'custom'}
              />
            </div>

            <div className="field">
              <span>默认模型</span>
              <div className="model-row">
                <div className="model-select">
                  <Select
                    value={settings.bailian.default_model}
                    options={
                      modelOptions.length === 0
                        ? [{ value: '', label: '(点右侧刷新获取模型)', disabled: true }]
                        : modelOptions.map((m) => ({ value: m, label: m }))
                    }
                    onChange={(v) => setPart('bailian', { default_model: v })}
                    placeholder="选择默认模型"
                  />
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={refreshModels}
                  disabled={refreshingModels}
                  title="从服务端点拉取最新模型列表"
                >
                  <RefreshCw size={14} className={refreshingModels ? 'spin' : ''} />
                  刷新
                </button>
              </div>
            </div>

            <div className="field inline">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.bailian.enabled}
                  onChange={(e) => setPart('bailian', { enabled: e.target.checked })}
                />
                <span className="switch-slider" />
              </label>
              <label>启用并写入 hermes 配置</label>
            </div>

            <button className="btn" onClick={test}>
              测试连接
            </button>
            {testOut && (
              <pre className={`output ${testOut.ok ? 'ok' : 'err'}`}>{testOut.text}</pre>
            )}
          </div>
        )}

        {section === 'feishu' && (
          <div className="settings-card">
            <h2>
              <img className="brand-ico lg" src="/brand/feishu.webp" alt="飞书" />
              飞书
            </h2>
            <p className="desc">
              配置飞书应用的 App ID 和 Secret。启用后 hermes 网关会连到 Lark 开放平台，用户在飞书中 @ bot 即可对话。
            </p>

            <div className="field">
              <span>App ID</span>
              <input
                type="text"
                value={settings.feishu.app_id}
                onChange={(e) => setPart('feishu', { app_id: e.target.value })}
                placeholder="cli_..."
              />
            </div>
            <div className="field">
              <span>App Secret</span>
              <input
                type="password"
                value={settings.feishu.app_secret}
                onChange={(e) => setPart('feishu', { app_secret: e.target.value })}
              />
            </div>
            <div className="field inline">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.feishu.enabled}
                  onChange={(e) => setPart('feishu', { enabled: e.target.checked })}
                />
                <span className="switch-slider" />
              </label>
              <label>启用</label>
            </div>
          </div>
        )}

        {section === 'dingtalk' && (
          <div className="settings-card">
            <h2>
              <img className="brand-ico lg" src="/brand/dingtalk.webp" alt="钉钉" />
              钉钉
            </h2>
            <p className="desc">
              配置钉钉企业应用的 Client ID 和 Secret（在开发者后台称为 AppKey / AppSecret）。启用后 hermes 通过 dingtalk-stream 接入。
            </p>

            <div className="field">
              <span>Client ID (AppKey)</span>
              <input
                type="text"
                value={settings.dingtalk.client_id}
                onChange={(e) => setPart('dingtalk', { client_id: e.target.value })}
              />
            </div>
            <div className="field">
              <span>Client Secret (AppSecret)</span>
              <input
                type="password"
                value={settings.dingtalk.client_secret}
                onChange={(e) => setPart('dingtalk', { client_secret: e.target.value })}
              />
            </div>
            <div className="field inline">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.dingtalk.enabled}
                  onChange={(e) => setPart('dingtalk', { enabled: e.target.checked })}
                />
                <span className="switch-slider" />
              </label>
              <label>启用</label>
            </div>
          </div>
        )}

        <div className="form-actions">
          <button className="btn primary" onClick={save}>
            <Save size={14} />
            保存
          </button>
          {saveMsg && (
            <span className={`inline-msg ${saveMsg.ok ? 'ok' : 'err'}`}>
              {saveMsg.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {saveMsg.text}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
