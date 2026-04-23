import { MessageSquare, Send, Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { api } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'

type MessageItem =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string; emoji: string; label: string }

interface Message {
  role: 'user' | 'assistant'
  items: MessageItem[]
  error?: boolean
}

const itemsToText = (items: MessageItem[]) =>
  items
    .filter((i): i is Extract<MessageItem, { type: 'text' }> => i.type === 'text')
    .map((i) => i.text)
    .join('')

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

// LocalStorage key for chat history (per-browser). Cross-device sync would
// need server-side persistence — see README.
const LS_MESSAGES = 'hc-chat-messages'

function loadMessages(): Message[] {
  try {
    const raw = localStorage.getItem(LS_MESSAGES)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveMessages(messages: Message[]) {
  try {
    // Cap history to last 200 messages to keep localStorage under the 5 MB
    // per-origin limit even for long sessions.
    const trimmed = messages.slice(-200)
    localStorage.setItem(LS_MESSAGES, JSON.stringify(trimmed))
  } catch {
    /* quota exceeded or disabled */
  }
}

export default function ChatTab() {
  // Display-only label. Hermes ignores the `model` field in chat completions
  // and uses whatever `~/.hermes/config.yaml::model.default` is configured,
  // so we just show the configured default as a read-only tag.
  const [currentModel, setCurrentModel] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>(loadMessages)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api
      .getSettings()
      .then((s) => setCurrentModel(s.bailian.default_model || ''))
      .catch(() => setCurrentModel(''))
  }, [])

  useEffect(() => {
    const id = setTimeout(() => saveMessages(messages), 200)
    return () => clearTimeout(id)
  }, [messages])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages])

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

    // Hermes derives its session_id from SHA256(system_prompt + first user
    // message), so passing the full history each turn reuses the same agent
    // session (memory, sandbox, etc.). We don't need to manage session IDs.
    const historyForApi = [
      ...messages.map((m) => ({ role: m.role, content: itemsToText(m.items) })),
      { role: 'user', content: userText },
    ]

    setMessages((prev) => [
      ...prev,
      { role: 'user', items: [{ type: 'text', text: userText }] },
      { role: 'assistant', items: [] },
    ])
    setInput('')
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const r = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Hermes ignores the `model` field and uses its own config, but the
        // request still needs a string for OpenAI-compatibility.
        body: JSON.stringify({
          model: currentModel || 'hermes-agent',
          messages: historyForApi,
          stream: true,
        }),
        signal: ctrl.signal,
      })
      if (!r.ok) {
        setAssistantError(`[${r.status}] ${await r.text()}`)
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
        setAssistantError(String(err.message ?? err))
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  const stop = () => abortRef.current?.abort()

  const clearHistory = () => {
    if (messages.length === 0) return
    setConfirmClear(true)
  }

  const doClearHistory = () => {
    setMessages([])
    localStorage.removeItem(LS_MESSAGES)
    setConfirmClear(false)
  }

  return (
    <div className="chat chat-solo">
      <ConfirmDialog
        open={confirmClear}
        title="清空对话历史"
        description={`将删除当前保存在浏览器里的 ${messages.length} 条消息。此操作不可撤销。`}
        confirmText="清空"
        cancelText="取消"
        variant="danger"
        onConfirm={doClearHistory}
        onCancel={() => setConfirmClear(false)}
      />
      <div className="chat-toolbar">
        <div className="chat-model-tag" title="在「设置 → 百炼」里切换默认模型">
          <span className="chat-model-tag-label">model</span>
          <span className="chat-model-tag-value">
            {currentModel || '(未配置)'}
          </span>
        </div>
        <span className="chat-toolbar-spacer" />
        <button
          className="btn ghost"
          onClick={clearHistory}
          disabled={messages.length === 0}
          title="清空对话历史"
        >
          <Trash2 size={14} />
          清空
        </button>
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="editor-placeholder">
            <MessageSquare size={40} />
            <div>开始你的对话</div>
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
        <div className="composer-hint">Enter 发送 · Shift+Enter 换行 · 历史保存在浏览器</div>
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
