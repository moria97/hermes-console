import {
  CheckCircle2,
  Image as ImageIcon,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ConsoleSettings, ProviderConfig } from '../api'
import bailianIcon from '../assets/brand/bailian.png'
import dingtalkIcon from '../assets/brand/dingtalk.png'
import feishuIcon from '../assets/brand/feishu.png'
import { sortModels } from '../lib'

type TopTab = 'models' | 'channels'
type ChannelSection = 'feishu' | 'dingtalk'
type ProviderType = 'public' | 'tokenplan' | 'coding' | 'custom'

interface ProviderPreset {
  id: ProviderType
  label: string
  url: string
  // True ⇒ /v1/models is queryable; False ⇒ use `recommended` only.
  supportsFetch: boolean
  recommended: string[]
}

const TOKENPLAN_RECOMMENDED = [
  'qwen3.6-plus',
  'glm-5',
  'MiniMax-M2.5',
  'deepseek-v3.2',
]
const CODING_RECOMMENDED = ['qwen3.6-plus', 'kimi-k2.5', 'glm-5', 'MiniMax-M2.5']

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'public',
    label: '百炼 API',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    supportsFetch: true,
    recommended: [],
  },
  {
    id: 'tokenplan',
    label: '百炼 Token Plan',
    url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    supportsFetch: false,
    recommended: TOKENPLAN_RECOMMENDED,
  },
  {
    id: 'coding',
    label: '百炼 Coding Plan',
    url: 'https://coding.dashscope.aliyuncs.com/v1',
    supportsFetch: false,
    recommended: CODING_RECOMMENDED,
  },
  {
    id: 'custom',
    label: 'Custom OpenAI Compatible Endpoint',
    url: '',
    supportsFetch: true,
    recommended: [],
  },
]

const presetById = (id: string) =>
  PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[3]

// Models that support image input. Surfaced as a small badge on each card.
const VISION_MODELS = new Set(['qwen3.6-plus', 'kimi-k2.5'])

// Stale/deprecated model IDs to hide even if the provider returns them.
const MODEL_DENY = new Set(['qwen3-plus'])

const DEFAULT: ConsoleSettings = {
  providers: [],
  active_provider: '',
  active_model: '',
  feishu: { app_id: '', app_secret: '' },
  dingtalk: { client_id: '', client_secret: '' },
}

interface SettingsTabProps {
  // Lets the bottom hint deep-link into the web terminal for advanced edits.
  onNavigateToTerminal?: () => void
}

export default function SettingsTab({ onNavigateToTerminal }: SettingsTabProps = {}) {
  const [tab, setTab] = useState<TopTab>('models')
  const [channelSection, setChannelSection] = useState<ChannelSection>('feishu')
  const [settings, setSettings] = useState<ConsoleSettings>(DEFAULT)
  const [loading, setLoading] = useState(true)
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // null = closed; { index: -1 } = creating new; { index: N } = editing existing
  const [editor, setEditor] = useState<{ index: number } | null>(null)

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch(() => setSettings(DEFAULT))
      .finally(() => setLoading(false))
  }, [])

  // ── Auto-save plumbing (model tab) ────────────────────────────────────
  // saveSettings always runs (config.yaml stays in sync). Reload-gateway is
  // gated by a runtime-relevance check + debounce: most edits (adding a
  // disabled provider, tweaking a non-active provider's model list) don't
  // change anything hermes is using right now, so they don't need a restart.
  // Burst-clicking the active model toggle coalesces into one restart.
  const reloadTimerRef = useRef<number | null>(null)
  const dismissTimerRef = useRef<number | null>(null)
  const flashSaveMsg = (msg: { ok: boolean; text: string }) => {
    setSaveMsg(msg)
    if (dismissTimerRef.current) window.clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = window.setTimeout(() => setSaveMsg(null), 3000)
  }
  const scheduleReload = () => {
    if (reloadTimerRef.current) window.clearTimeout(reloadTimerRef.current)
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null
      api.reloadGateway().catch(() => {
        /* gateway may be mid-restart; ignore */
      })
    }, 800)
  }
  // Hash the bits hermes actually reads at runtime: which provider is
  // active, its credentials, and which model is the default. Anything that
  // doesn't change this hash (e.g. editing a disabled provider) skips the
  // gateway restart.
  const runtimeHash = (s: ConsoleSettings): string => {
    const a = s.providers.find((p) => p.name === s.active_provider)
    if (!a || !s.active_model) return 'inactive'
    return `${a.name}|${a.base_url}|${a.api_key}|${s.active_model}`
  }
  const persist = async (target: ConsoleSettings, prevHash: string) => {
    try {
      const saved = await api.saveSettings(target)
      setSettings(saved)
      window.dispatchEvent(
        new CustomEvent('console-settings-saved', { detail: saved }),
      )
      flashSaveMsg({ ok: true, text: '已保存' })
      if (runtimeHash(saved) !== prevHash) scheduleReload()
    } catch (e: any) {
      flashSaveMsg({ ok: false, text: `保存失败: ${e.message ?? e}` })
    }
  }

  const enableModel = (providerName: string, modelId: string) => {
    setSettings((s) => {
      const prevHash = runtimeHash(s)
      const off =
        s.active_provider === providerName && s.active_model === modelId
      const next = off
        ? { ...s, active_provider: '', active_model: '' }
        : { ...s, active_provider: providerName, active_model: modelId }
      void persist(next, prevHash)
      return next
    })
  }

  const upsertProvider = (idx: number, p: ProviderConfig) => {
    setSettings((s) => {
      const prevHash = runtimeHash(s)
      const providers =
        idx >= 0
          ? s.providers.map((x, i) => (i === idx ? p : x))
          : [...s.providers, p]
      // If the active model isn't in the new selection, clear actives.
      let { active_provider, active_model } = s
      if (active_provider === p.name && !p.models.includes(active_model)) {
        active_provider = ''
        active_model = ''
      }
      const next = { ...s, providers, active_provider, active_model }
      void persist(next, prevHash)
      return next
    })
  }

  const deleteProvider = (idx: number) => {
    const target = settings.providers[idx]
    if (!target) return
    if (
      !window.confirm(
        `确定删除 Provider「${labelForProvider(target)}」？已选模型卡片会一并移除。`,
      )
    ) {
      return
    }
    setSettings((s) => {
      const prevHash = runtimeHash(s)
      const providers = s.providers.filter((_, i) => i !== idx)
      const clearActive = s.active_provider === target.name
      const next = {
        ...s,
        providers,
        active_provider: clearActive ? '' : s.active_provider,
        active_model: clearActive ? '' : s.active_model,
      }
      void persist(next, prevHash)
      return next
    })
  }

  const setFeishu = (patch: Partial<ConsoleSettings['feishu']>) =>
    setSettings((s) => ({ ...s, feishu: { ...s.feishu, ...patch } }))
  const setDingtalk = (patch: Partial<ConsoleSettings['dingtalk']>) =>
    setSettings((s) => ({ ...s, dingtalk: { ...s.dingtalk, ...patch } }))

  // Manual save — used only by the channel tab. Channel inputs are
  // typed character-by-character so per-keystroke save would hammer
  // config.yaml.
  const save = async () => {
    try {
      const saved = await api.saveSettings(settings)
      setSettings(saved)
      window.dispatchEvent(
        new CustomEvent('console-settings-saved', { detail: saved }),
      )
      flashSaveMsg({ ok: true, text: '已保存' })
      try {
        const r = await api.reloadGateway()
        flashSaveMsg({
          ok: true,
          text: r.reloaded
            ? '已保存并重载网关'
            : '已保存（' + (r.hint ?? '重启容器生效') + '）',
        })
      } catch {
        /* ignore */
      }
    } catch (e: any) {
      flashSaveMsg({ ok: false, text: `保存失败: ${e.message ?? e}` })
    }
  }

  if (loading) return <div className="editor-placeholder">加载中…</div>

  const saveBar = (
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
  )

  return (
    <div className="settings-page">
      <div className="settings-tabs">
        <button
          className={tab === 'models' ? 'active' : ''}
          onClick={() => setTab('models')}
        >
          模型配置
        </button>
        <button
          className={tab === 'channels' ? 'active' : ''}
          onClick={() => setTab('channels')}
        >
          Channel 配置
        </button>
      </div>

      <div className="settings-info-banner">
        <Info size={14} />
        <span>
          这里只覆盖最常用的几项。需要更细的配置（比如 hooks、cron、平台 allowlist
          等），可以直接编辑{' '}
          <code>~/.hermes/config.yaml</code>，或者打开{' '}
          {onNavigateToTerminal ? (
            <button
              type="button"
              className="link-btn"
              onClick={onNavigateToTerminal}
            >
              终端
            </button>
          ) : (
            <span>终端</span>
          )}
          {' '}用 hermes CLI 设置。
        </span>
      </div>

      {tab === 'models' && (
        <div className="settings-body model-list">
          <div className="auto-save-hint">
            <span>更改会自动保存并重载网关。</span>
            {saveMsg && (
              <span className={`inline-msg ${saveMsg.ok ? 'ok' : 'err'}`}>
                {saveMsg.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {saveMsg.text}
              </span>
            )}
          </div>
          {settings.providers.length === 0 && (
            <div className="model-empty">
              暂无 Provider。点击下方“添加 Provider”，从百炼 API / Token Plan / Coding Plan / 自定义端点中挑一种开始。
            </div>
          )}
          {settings.providers.map((p, i) => (
            <ProviderGroup
              key={p.name || `idx-${i}`}
              provider={p}
              activeProvider={settings.active_provider}
              activeModel={settings.active_model}
              onToggleModel={(modelId) => enableModel(p.name, modelId)}
              onEdit={() => setEditor({ index: i })}
              onDelete={() => deleteProvider(i)}
            />
          ))}
          <button
            className="btn add-model-btn"
            onClick={() => setEditor({ index: -1 })}
          >
            <Plus size={14} />
            添加 Provider
          </button>
        </div>
      )}

      {tab === 'channels' && (
        <div className="settings">
          <nav className="settings-nav">
            <button
              className={channelSection === 'feishu' ? 'active' : ''}
              onClick={() => setChannelSection('feishu')}
            >
              <img className="brand-ico" src={feishuIcon} alt="飞书" />
              飞书
            </button>
            <button
              className={channelSection === 'dingtalk' ? 'active' : ''}
              onClick={() => setChannelSection('dingtalk')}
            >
              <img className="brand-ico" src={dingtalkIcon} alt="钉钉" />
              钉钉
            </button>
          </nav>
          <div className="settings-body">
            {channelSection === 'feishu' && (
              <div className="settings-card">
                <h2>
                  <img className="brand-ico lg" src={feishuIcon} alt="飞书" />
                  飞书
                </h2>
                <p className="desc">
                  配置飞书应用的 App ID 和 Secret。凭证完整后 hermes 网关会连到 Lark 开放平台，用户在飞书中 @ bot 即可对话。
                </p>
                <div className="field">
                  <span>App ID</span>
                  <input
                    type="text"
                    value={settings.feishu.app_id}
                    onChange={(e) => setFeishu({ app_id: e.target.value })}
                    placeholder="cli_..."
                  />
                </div>
                <div className="field">
                  <span>App Secret</span>
                  <input
                    type="password"
                    value={settings.feishu.app_secret}
                    onChange={(e) => setFeishu({ app_secret: e.target.value })}
                  />
                </div>
              </div>
            )}
            {channelSection === 'dingtalk' && (
              <div className="settings-card">
                <h2>
                  <img className="brand-ico lg" src={dingtalkIcon} alt="钉钉" />
                  钉钉
                </h2>
                <p className="desc">
                  配置钉钉企业应用的 Client ID 和 Secret（在开发者后台称为 AppKey / AppSecret）。凭证完整后 hermes 通过 dingtalk-stream 接入。
                </p>
                <div className="field">
                  <span>Client ID (AppKey)</span>
                  <input
                    type="text"
                    value={settings.dingtalk.client_id}
                    onChange={(e) => setDingtalk({ client_id: e.target.value })}
                  />
                </div>
                <div className="field">
                  <span>Client Secret (AppSecret)</span>
                  <input
                    type="password"
                    value={settings.dingtalk.client_secret}
                    onChange={(e) =>
                      setDingtalk({ client_secret: e.target.value })
                    }
                  />
                </div>
              </div>
            )}
            {saveBar}
          </div>
        </div>
      )}

      {editor && (
        <ProviderEditor
          initial={editor.index >= 0 ? settings.providers[editor.index] : null}
          onCancel={() => setEditor(null)}
          onSave={(p) => {
            upsertProvider(editor.index, p)
            setEditor(null)
          }}
        />
      )}
    </div>
  )
}

// ─── ProviderGroup ────────────────────────────────────────────────────────

interface ProviderGroupProps {
  provider: ProviderConfig
  activeProvider: string
  activeModel: string
  onToggleModel: (modelId: string) => void
  onEdit: () => void
  onDelete: () => void
}

function labelForProvider(p: ProviderConfig): string {
  const preset = presetById(p.type)
  if (p.type === 'custom') {
    try {
      const host = new URL(p.base_url).host || p.base_url
      return `自定义端点 — ${host}`
    } catch {
      return preset.label
    }
  }
  return preset.label
}

function ProviderGroup({
  provider,
  activeProvider,
  activeModel,
  onToggleModel,
  onEdit,
  onDelete,
}: ProviderGroupProps) {
  return (
    <section className="provider-group">
      <header className="provider-group-header">
        <div className="provider-group-title">
          <img className="brand-ico lg" src={bailianIcon} alt="" />
          <h3>{labelForProvider(provider)}</h3>
        </div>
        <div className="provider-group-actions">
          <button
            className="btn icon-only"
            onClick={onEdit}
            title="编辑 Provider"
            aria-label="编辑"
          >
            <Pencil size={14} />
          </button>
          <button
            className="btn icon-only danger"
            onClick={onDelete}
            title="删除 Provider"
            aria-label="删除"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </header>
      {provider.models.length === 0 ? (
        <div className="model-empty inline">
          这个 Provider 当前没有选中任何模型，点编辑可以挑选。
        </div>
      ) : (
        <div className="model-card-grid">
          {provider.models.map((modelId) => {
            const enabled =
              activeProvider === provider.name && activeModel === modelId
            return (
              <ModelPill
                key={modelId}
                modelId={modelId}
                enabled={enabled}
                onToggle={() => onToggleModel(modelId)}
              />
            )
          })}
        </div>
      )}
    </section>
  )
}

// ─── ModelPill ────────────────────────────────────────────────────────────

interface ModelPillProps {
  modelId: string
  enabled: boolean
  onToggle: () => void
}

function ModelPill({ modelId, enabled, onToggle }: ModelPillProps) {
  const vision = VISION_MODELS.has(modelId)
  return (
    <div className={`model-pill ${enabled ? 'enabled' : ''}`}>
      <div className="model-pill-main">
        <div className="model-pill-name">{modelId}</div>
        {vision && (
          <span className="model-pill-badge" title="支持图片理解">
            <ImageIcon size={11} /> 图片
          </span>
        )}
      </div>
      <label className="switch" title={enabled ? '已设为默认' : '设为默认'}>
        <input type="checkbox" checked={enabled} onChange={onToggle} />
        <span className="switch-slider" />
      </label>
    </div>
  )
}

// ─── ProviderEditor (modal) ───────────────────────────────────────────────

interface ProviderEditorProps {
  initial: ProviderConfig | null
  onCancel: () => void
  onSave: (p: ProviderConfig) => void
}

function ProviderEditor({ initial, onCancel, onSave }: ProviderEditorProps) {
  const [type, setType] = useState<ProviderType>(
    (initial?.type as ProviderType) || 'public',
  )
  const [baseUrl, setBaseUrl] = useState<string>(
    initial?.base_url || presetById('public').url,
  )
  const [apiKey, setApiKey] = useState<string>(initial?.api_key || '')
  const [available, setAvailable] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initial?.models || []),
  )
  const [busy, setBusy] = useState<'fetch' | 'submit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const preset = useMemo(() => presetById(type), [type])

  // Whenever the preset changes (or on first mount), re-seed base_url and the
  // available-models list from the preset's recommended set. Existing
  // selections are preserved when editing.
  useEffect(() => {
    if (preset.id !== 'custom') setBaseUrl(preset.url)
    else if (initial?.type === 'custom') setBaseUrl(initial.base_url)
    else setBaseUrl('')

    if (preset.recommended.length > 0) {
      setAvailable(sortModels(preset.recommended))
      // First time seeing this preset (no initial of same type) → preselect.
      if (!initial || initial.type !== preset.id) {
        setSelected(new Set(preset.recommended))
      }
    } else {
      // Dynamic preset — start with whatever was previously selected so the
      // user sees their existing choices; they can refresh to pull the full list.
      setAvailable(sortModels(Array.from(selected)))
    }
    setError(null)
    setInfo(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type])

  const fetchModels = async () => {
    if (!apiKey) {
      setError('请先填写 API Key')
      return
    }
    setBusy('fetch')
    setError(null)
    setInfo(null)
    try {
      const r = await api.testModel({
        api_key: apiKey,
        base_url: baseUrl,
        mode: 'fetch',
      })
      const filtered = r.models.filter((m) => !MODEL_DENY.has(m))
      const sorted = sortModels(filtered)
      // Merge previously-selected ids that aren't in the response so the user
      // doesn't lose their selections to a one-off API hiccup.
      const merged = sortModels(
        Array.from(new Set([...sorted, ...Array.from(selected)])),
      )
      setAvailable(merged)
      setInfo(`已获取 ${sorted.length} 个模型`)
    } catch (e: any) {
      setError(`无法连接：${e.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  const submit = async () => {
    if (!baseUrl) {
      setError('请填写 Base URL')
      return
    }
    if (!apiKey) {
      setError('请填写 API Key')
      return
    }
    if (selected.size === 0) {
      setError('至少选择一个模型')
      return
    }
    setBusy('submit')
    setError(null)
    setInfo(null)
    try {
      // Always ping on create AND edit. Spec: ping fails ⇒ block create.
      // For endpoints without /v1/models (Bailian Coding Plan), fall back
      // to an auth-mode probe (POST /chat/completions, max_tokens=1).
      if (preset.supportsFetch) {
        await api.testModel({ api_key: apiKey, base_url: baseUrl, mode: 'fetch' })
      } else {
        await api.testModel({
          api_key: apiKey,
          base_url: baseUrl,
          mode: 'auth',
          model: Array.from(selected)[0],
        })
      }
    } catch (e: any) {
      setError(`无法连接：${e.message ?? e}`)
      setBusy(null)
      return
    }
    setBusy(null)
    onSave({
      name: initial?.name || '',
      type,
      base_url: baseUrl,
      api_key: apiKey,
      models: Array.from(selected),
    })
  }

  const toggleSelect = (modelId: string) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(modelId)) next.delete(modelId)
      else next.add(modelId)
      return next
    })
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <h2>{initial ? '编辑 Provider' : '添加 Provider'}</h2>

        <div className="field">
          <span>Provider 类型</span>
          <div className="provider-type-grid">
            {PROVIDER_PRESETS.map((p) => (
              <label
                key={p.id}
                className={`provider-type-option ${type === p.id ? 'active' : ''}`}
              >
                <input
                  type="radio"
                  name="provider-type"
                  checked={type === p.id}
                  onChange={() => setType(p.id)}
                />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Base URL</span>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://..."
            readOnly={type !== 'custom'}
          />
        </div>

        <div className="field">
          <span>API Key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
          />
        </div>

        <div className="field">
          <div className="model-selection-header">
            <span>选择模型</span>
            {preset.supportsFetch ? (
              <button
                type="button"
                className="btn"
                onClick={fetchModels}
                disabled={busy !== null}
              >
                <RefreshCw
                  size={13}
                  className={busy === 'fetch' ? 'spin' : ''}
                />
                拉取模型列表
              </button>
            ) : (
              <span className="hint">该端点不支持 /v1/models，使用推荐模型</span>
            )}
          </div>
          {available.length === 0 ? (
            <div className="model-empty inline">
              {preset.supportsFetch
                ? '点上方“拉取模型列表”加载可用模型。'
                : '没有可用模型。'}
            </div>
          ) : (
            <div className="model-checklist">
              {available.map((m) => (
                <label key={m} className="model-checklist-item">
                  <input
                    type="checkbox"
                    checked={selected.has(m)}
                    onChange={() => toggleSelect(m)}
                  />
                  <span className="model-checklist-name">{m}</span>
                  {VISION_MODELS.has(m) && (
                    <span className="model-pill-badge" title="支持图片理解">
                      <ImageIcon size={11} /> 图片
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="inline-msg err">
            <XCircle size={14} /> {error}
          </div>
        )}
        {info && !error && (
          <div className="inline-msg ok">
            <CheckCircle2 size={14} /> {info}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy !== null}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={busy !== null}
          >
            {busy === 'submit' ? '测试中…' : initial ? '保存' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
