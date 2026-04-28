import { MessageSquare, Plus, RefreshCw, Send, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { api, HermesMessageRow, HermesSessionRow } from '../api'

type MessageItem =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string; emoji: string; label: string }

interface Message {
  role: 'user' | 'assistant'
  items: MessageItem[]
  error?: boolean
}

// Convert hermes-stored DB rows → the UI's Message[] shape. Tool/system
// rows from the DB are folded into a chip on the preceding assistant
// turn (or skipped if there's none) so the rendered conversation matches
// the streaming UX.
function dbRowsToMessages(rows: HermesMessageRow[]): Message[] {
  const out: Message[] = []
  for (const r of rows) {
    if (r.role === 'system') continue
    if (r.role === 'tool') {
      const last = out[out.length - 1]
      if (last && last.role === 'assistant') {
        const label = (r.content || '').slice(0, 200)
        last.items.push({
          type: 'tool',
          tool: r.tool_name || 'tool',
          emoji: '✓',
          label,
        })
      }
      continue
    }
    if (r.role === 'user' || r.role === 'assistant') {
      const items: MessageItem[] = []
      if (r.content) items.push({ type: 'text', text: r.content })
      // Surface assistant tool_calls as chips so users see what the model invoked.
      if (r.role === 'assistant' && Array.isArray(r.tool_calls)) {
        for (const tc of r.tool_calls) {
          const fn = tc?.function?.name || tc?.name || 'tool'
          let argsLabel = ''
          try {
            const args = tc?.function?.arguments
            argsLabel =
              typeof args === 'string' ? args : JSON.stringify(args ?? '')
          } catch {
            /* ignore */
          }
          items.push({
            type: 'tool',
            tool: String(fn),
            emoji: '🔧',
            label: argsLabel.slice(0, 200),
          })
        }
      }
      out.push({ role: r.role, items })
    }
  }
  return out
}

// Event-aware SSE parser: each blank-line separated block may carry an
// `event:` line (defaults to 'message') and one or more `data:` lines.
async function parseSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: string, data: string) => void,
) {
  const dec = new TextDecoder()
  let buf = ''
  const flushBlock = (raw: string) => {
    let eventName = 'message'
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length > 0) onEvent(eventName, dataLines.join('\n'))
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let sep: number
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      flushBlock(buf.slice(0, sep))
      buf = buf.slice(sep + 2)
    }
  }
  if (buf.trim()) flushBlock(buf)
}

// Translate raw HTTP errors / fetch exceptions into something a non-engineer
// can act on. Common cases right after saving settings:
//   - the gateway is mid-respawn (~30s window) → connection refused / 502
//   - bailian wasn't enabled or no API key → hermes complains about missing
//     provider / model
function explainChatError(status: number, body: string): string {
  const lower = body.toLowerCase()

  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return [
      '⚠️ 网关暂时不可用',
      '',
      '可能原因：',
      '• 刚保存了设置，gateway 正在重启（约 30 秒）',
      '• hermes-agent 服务还没起来',
      '',
      '请稍候片刻再试。',
    ].join('\n')
  }

  if (
    lower.includes('no provider') ||
    lower.includes('no model') ||
    lower.includes('api key') ||
    lower.includes('apikey') ||
    lower.includes('unauthorized') ||
    status === 401 ||
    status === 403
  ) {
    return [
      '⚠️ 模型未配置或配置无效',
      '',
      '请去 **快速设置 → 模型配置**：',
      '1. 添加一个 Provider（百炼 / Token Plan / Coding Plan / Custom）',
      '2. 启用其中一个模型',
      '',
      `服务端原始响应（${status}）：`,
      '```',
      body.slice(0, 500),
      '```',
    ].join('\n')
  }

  return `[${status}] ${body || '(空响应体)'}`
}

function explainFetchError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return [
      '⚠️ 网络中断 / 网关不可达',
      '',
      'gateway 可能正在重启（设置保存后约 30 秒），或者后端服务挂了。',
      '请稍候再试，如持续不行检查 `docker logs hermes-console`。',
    ].join('\n')
  }
  return msg
}

const sessionLabel = (s: HermesSessionRow): string => {
  if (s.title && s.title.trim()) return s.title.trim()
  if (s.preview && s.preview.trim()) return s.preview.trim()
  return s.id.slice(0, 16)
}

const formatRelativeTime = (epoch: number): string => {
  const ms = Date.now() - epoch * 1000
  if (ms < 0) return '刚刚'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s 前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(epoch * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface ChatTabProps {
  // Lets the chat tag jump straight into 快速设置 when no model is configured.
  onNavigateToSettings?: () => void
}

const SESSION_LIMIT = 50

// Generate a session id client-side so we know it before the first send and
// can pass it back to hermes via X-Hermes-Session-Id from turn one. Hermes
// happily uses any non-empty string; we use a short, URL-safe slug to keep
// the toolbar pill readable.
function newSessionId(): string {
  const u = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return 'console-' + u.replace(/-/g, '').slice(0, 16)
}

export default function ChatTab({ onNavigateToSettings }: ChatTabProps = {}) {
  // Display-only label. Hermes ignores the request `model` field and uses
  // ~/.hermes/config.yaml::model.default — we just show that as a tag.
  const [currentModel, setCurrentModel] = useState<string>('')
  const [sessions, setSessions] = useState<HermesSessionRow[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  // Always non-null: either a freshly-generated id for a new chat, or the
  // id of a session loaded from the sidebar. Sent on every chat completion
  // request via the X-Hermes-Session-Id header.
  const [currentSessionId, setCurrentSessionId] = useState<string>(newSessionId)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const refreshSessions = async () => {
    try {
      const list = await api.listSessions(SESSION_LIMIT)
      setSessions(list)
    } catch {
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }

  useEffect(() => {
    void refreshSessions()
  }, [])

  useEffect(() => {
    void api
      .getSettings()
      .then((s) => setCurrentModel(s.active_model || ''))
      .catch(() => setCurrentModel(''))
    const handler = (e: Event) => {
      const settings = (e as CustomEvent).detail as
        | { active_model?: string }
        | undefined
      if (settings) setCurrentModel(settings.active_model || '')
    }
    window.addEventListener('console-settings-saved', handler)
    return () => window.removeEventListener('console-settings-saved', handler)
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages])

  const openSession = async (id: string) => {
    if (streaming) return
    if (id === currentSessionId) return
    try {
      const detail = await api.getSession(id)
      setCurrentSessionId(detail.session.id)
      setMessages(dbRowsToMessages(detail.messages))
    } catch (e: any) {
      setMessages([
        {
          role: 'assistant',
          items: [{ type: 'text', text: `加载会话失败：${e.message ?? e}` }],
          error: true,
        },
      ])
      // On open failure, fall back to a fresh client-generated id so the
      // composer stays usable.
      setCurrentSessionId(newSessionId())
    }
  }

  const newSession = () => {
    if (streaming) return
    setCurrentSessionId(newSessionId())
    setMessages([])
    setInput('')
  }

  const appendText = (delta: string) => {
    setMessages((prev) => {
      const msgs = prev.slice()
      const last = msgs[msgs.length - 1]
      if (!last || last.role !== 'assistant') return prev
      const items = last.items.slice()
      const tail = items[items.length - 1]
      if (tail?.type === 'text') {
        items[items.length - 1] = { type: 'text', text: tail.text + delta }
      } else {
        items.push({ type: 'text', text: delta })
      }
      msgs[msgs.length - 1] = { ...last, items }
      return msgs
    })
  }

  const pushTool = (chip: Extract<MessageItem, { type: 'tool' }>) => {
    setMessages((prev) => {
      const msgs = prev.slice()
      const last = msgs[msgs.length - 1]
      if (!last || last.role !== 'assistant') return prev
      msgs[msgs.length - 1] = { ...last, items: [...last.items, chip] }
      return msgs
    })
  }

  const setAssistantError = (text: string) => {
    setMessages((prev) => {
      const msgs = prev.slice()
      msgs[msgs.length - 1] = {
        role: 'assistant',
        items: [{ type: 'text', text }],
        error: true,
      }
      return msgs
    })
  }

  const send = async () => {
    if (!input.trim() || streaming) return
    const userText = input.trim()

    // We always carry an X-Hermes-Session-Id, so hermes can load server-side
    // history from state.db itself — we only need to ship the new user turn.
    // (For a brand-new id, the server-side history is empty; hermes appends
    // and persists this turn under that id.)
    const requestMessages = [{ role: 'user' as const, content: userText }]

    setMessages((prev) => [
      ...prev,
      { role: 'user', items: [{ type: 'text', text: userText }] },
      { role: 'assistant', items: [] },
    ])
    setInput('')
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-hermes-session-id': currentSessionId,
    }

    try {
      const r = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: currentModel || 'hermes-agent',
          messages: requestMessages,
          stream: true,
        }),
        signal: ctrl.signal,
      })
      // Capture (or update) the session id from the response header — hermes
      // emits it on every successful response, even on errors-with-headers.
      const replied = r.headers.get('x-hermes-session-id')
      if (replied && replied !== currentSessionId) setCurrentSessionId(replied)

      if (!r.ok) {
        setAssistantError(explainChatError(r.status, await r.text()))
        return
      }
      await parseSSE(r.body!.getReader(), (event, data) => {
        if (event === 'hermes.tool.progress') {
          try {
            const j = JSON.parse(data)
            pushTool({
              type: 'tool',
              tool: String(j.tool ?? 'tool'),
              emoji: String(j.emoji ?? '🔧'),
              label: String(j.label ?? ''),
            })
          } catch {
            /* ignore partial */
          }
          return
        }
        if (data === '[DONE]') return
        try {
          const j = JSON.parse(data)
          const delta = j.choices?.[0]?.delta?.content
          if (delta) appendText(delta)
        } catch {
          /* ignore partial */
        }
      })
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setAssistantError(explainFetchError(err))
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
      // Refresh the sidebar so the new/updated session bubbles to the top.
      void refreshSessions()
    }
  }

  const stop = () => abortRef.current?.abort()

  return (
    <div className="chat">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-header">
          <button
            className="btn primary"
            onClick={newSession}
            disabled={streaming}
            title="开始一个新会话"
          >
            <Plus size={14} />
            新会话
          </button>
          <button
            className="btn icon-only"
            onClick={() => void refreshSessions()}
            disabled={sessionsLoading}
            title="刷新会话列表"
            aria-label="刷新"
          >
            <RefreshCw size={14} className={sessionsLoading ? 'spin' : ''} />
          </button>
        </div>
        <div className="chat-sidebar-list">
          {sessionsLoading && sessions.length === 0 && (
            <div className="chat-sidebar-empty">加载中…</div>
          )}
          {!sessionsLoading && sessions.length === 0 && (
            <div className="chat-sidebar-empty">还没有会话记录。</div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`chat-session-row ${currentSessionId === s.id ? 'active' : ''}`}
              onClick={() => void openSession(s.id)}
              disabled={streaming}
            >
              <div className="chat-session-row-title">{sessionLabel(s)}</div>
              <div className="chat-session-row-meta">
                <span>{s.model || '—'}</span>
                <span>·</span>
                <span>{s.message_count} 条</span>
                <span>·</span>
                <span>{formatRelativeTime(s.started_at)}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="chat-main">
        <div className="chat-toolbar">
          {currentModel ? (
            <div
              className="chat-model-tag"
              title="在「快速设置 → 模型配置」里切换默认模型"
            >
              <span className="chat-model-tag-label">model</span>
              <span className="chat-model-tag-value">{currentModel}</span>
            </div>
          ) : (
            <button
              type="button"
              className="chat-model-tag chat-model-tag-empty"
              onClick={onNavigateToSettings}
              title="跳转到快速设置配置默认模型"
            >
              <span className="chat-model-tag-label">model</span>
              <span className="chat-model-tag-value">未配置 · 去设置 →</span>
            </button>
          )}
          <span className="chat-toolbar-spacer" />
          <span
            className="chat-session-id-tag"
            title={`hermes session id: ${currentSessionId}`}
          >
            {currentSessionId.length > 14
              ? currentSessionId.slice(0, 14) + '…'
              : currentSessionId}
          </span>
        </div>

        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && (
            <div className="editor-placeholder">
              <MessageSquare size={40} />
              <div>开始你的对话，或从左侧挑一条历史会话继续</div>
            </div>
          )}
          {messages.map((m, i) => {
            const isLastStreaming =
              streaming && i === messages.length - 1 && m.role === 'assistant'
            const isEmpty = m.items.length === 0
            return (
              <div key={i} className={`msg-row ${m.role}`}>
                <div className={`avatar ${m.role}`}>
                  {m.role === 'user' ? (
                    'U'
                  ) : (
                    <img src="/favicon.ico" alt="Hermes" />
                  )}
                </div>
                <div className={`msg ${m.role}${m.error ? ' error' : ''}`}>
                  {isEmpty && isLastStreaming && <span className="cursor" />}
                  {m.items.map((it, idx) => {
                    if (it.type === 'tool') {
                      return (
                        <ToolChip
                          key={idx}
                          tool={it.tool}
                          emoji={it.emoji}
                          label={it.label}
                        />
                      )
                    }
                    const isLastItem = idx === m.items.length - 1
                    return (
                      <div key={idx} className="md-block">
                        {m.role === 'user' ? (
                          <span style={{ whiteSpace: 'pre-wrap' }}>{it.text}</span>
                        ) : (
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                            {it.text}
                          </ReactMarkdown>
                        )}
                        {isLastStreaming && isLastItem && <span className="cursor" />}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <div className="composer">
          <div className="composer-inner">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              onKeyDown={(e) => {
                const composing =
                  e.nativeEvent.isComposing || (e.nativeEvent as any).keyCode === 229
                if (e.key === 'Enter' && !e.shiftKey && !composing) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={2}
            />
            <button
              className="btn primary icon-only"
              style={{ width: 36, height: 36 }}
              onClick={streaming ? stop : send}
              disabled={!streaming && !input.trim()}
              title={streaming ? '停止' : '发送 (Enter)'}
            >
              {streaming ? <Square size={14} /> : <Send size={15} />}
            </button>
          </div>
          <div className="composer-hint">
            Enter 发送 · Shift+Enter 换行 · 历史由 hermes 服务端持久化
          </div>
        </div>
      </div>
    </div>
  )
}

function ToolChip({ tool, emoji, label }: { tool: string; emoji: string; label: string }) {
  const [open, setOpen] = useState(false)
  const truncated = label.length > 80 ? label.slice(0, 80) + '…' : label
  const canExpand = label.length > 80
  return (
    <div
      className={`tool-chip ${open ? 'expanded' : ''}`}
      onClick={() => canExpand && setOpen(!open)}
      role={canExpand ? 'button' : undefined}
      title={canExpand ? (open ? '收起' : '展开') : undefined}
    >
      <span className="tool-emoji">{emoji}</span>
      <span className="tool-name">{tool}</span>
      <span className="tool-label">{open ? label : truncated}</span>
    </div>
  )
}
