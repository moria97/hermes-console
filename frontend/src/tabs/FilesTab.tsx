import Editor from '@monaco-editor/react'
import {
  ArrowUpFromLine,
  CheckCircle2,
  File,
  FilePlus,
  Folder,
  RefreshCw,
  RotateCw,
  Save,
  X,
  XCircle,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, FileNode } from '../api'

interface OpenFile {
  path: string
  content: string
  originalContent: string
  dirty: boolean
  language: string
}

const LANG_MAP: Record<string, string> = {
  js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', md: 'markdown',
  html: 'html', css: 'css', scss: 'scss', sh: 'shell', bash: 'shell',
  sql: 'sql', dockerfile: 'dockerfile',
}

const detectLang = (path: string) => {
  const name = path.split('/').pop()!.toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  const ext = name.split('.').pop() ?? ''
  return LANG_MAP[ext] ?? 'plaintext'
}

// A file whose content the gateway reads at startup — editing it warrants
// the "save + reload gateway" shortcut instead of plain save.
const affectsGateway = (path: string) => {
  const name = path.split('/').pop() || ''
  if (name === '.env' || name.endsWith('.env')) return true
  return /\.ya?ml$/i.test(name)
}

export default function FilesTab() {
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FileNode[]>([])
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const [reloadMsg, setReloadMsg] = useState<
    | { ok: boolean; text: string }
    | null
  >(null)

  const refresh = async (path = cwd) => {
    try {
      const r = await api.tree(path)
      setCwd(r.path)
      setEntries(r.entries)
      setErr(null)
    } catch (e: any) {
      setErr(String(e.message ?? e))
    }
  }

  useEffect(() => {
    refresh('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openFile = async (path: string) => {
    if (openFiles.some((f) => f.path === path)) {
      setActivePath(path)
      return
    }
    try {
      const r = await api.read(path)
      if (r.binary) {
        alert('二进制文件暂不支持预览')
        return
      }
      const lang = detectLang(path)
      setOpenFiles((prev) => [
        ...prev,
        { path, content: r.content, originalContent: r.content, dirty: false, language: lang },
      ])
      setActivePath(path)
    } catch (e: any) {
      alert(`打开失败: ${e.message ?? e}`)
    }
  }

  const closeFile = (path: string) => {
    const f = openFiles.find((x) => x.path === path)
    if (f?.dirty && !confirm(`放弃 ${path} 的修改？`)) return
    const next = openFiles.filter((x) => x.path !== path)
    setOpenFiles(next)
    if (activePath === path) setActivePath(next[0]?.path ?? null)
  }

  const updateContent = (path: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) =>
        f.path === path
          ? { ...f, content, dirty: content !== f.originalContent }
          : f,
      ),
    )
  }

  const saveActive = async () => {
    if (!activePath) return
    const f = openFiles.find((x) => x.path === activePath)
    if (!f || !f.dirty) return
    try {
      await api.write(f.path, f.content)
      setOpenFiles((prev) =>
        prev.map((x) =>
          x.path === f.path ? { ...x, originalContent: x.content, dirty: false } : x,
        ),
      )
    } catch (e: any) {
      alert(`保存失败: ${e.message ?? e}`)
    }
  }

  const saveAndReloadGateway = async () => {
    if (!activePath) return
    const f = openFiles.find((x) => x.path === activePath)
    if (!f) return
    setReloading(true)
    setReloadMsg(null)
    try {
      if (f.dirty) {
        await api.write(f.path, f.content)
        setOpenFiles((prev) =>
          prev.map((x) =>
            x.path === f.path ? { ...x, originalContent: x.content, dirty: false } : x,
          ),
        )
      }
      const r = await api.reloadGateway()
      setReloadMsg({
        ok: r.reloaded,
        text: r.reloaded
          ? `已重启网关 (pid ${r.old_pid ?? '?'} → ${r.new_pid ?? '?'})`
          : r.hint ?? '未重启（详情见服务端日志）',
      })
    } catch (e: any) {
      setReloadMsg({ ok: false, text: `失败: ${e.message ?? e}` })
    } finally {
      setReloading(false)
      setTimeout(() => setReloadMsg(null), 6000)
    }
  }

  const deleteEntry = async (path: string) => {
    if (!confirm(`删除 ${path}？`)) return
    try {
      await api.remove(path)
      refresh()
    } catch (e: any) {
      alert(`删除失败: ${e.message ?? e}`)
    }
  }

  const createFile = async () => {
    const name = prompt('新文件路径 (相对当前根目录):')
    if (!name) return
    try {
      await api.write(name, '')
      refresh()
    } catch (e: any) {
      alert(`创建失败: ${e.message ?? e}`)
    }
  }

  const active = openFiles.find((f) => f.path === activePath) ?? null
  const parent = cwd ? cwd.split('/').slice(0, -1).join('/') : null

  return (
    <div className="files">
      <aside className="side">
        <div className="file-tree-head">
          <button className="btn icon-only" onClick={() => refresh()} title="刷新">
            <RefreshCw size={14} />
          </button>
          <button className="btn icon-only" onClick={createFile} title="新建文件">
            <FilePlus size={14} />
          </button>
          <span className="cwd">/{cwd}</span>
        </div>
        <ul className="list file-tree">
          {parent !== null && (
            <li className="up" onClick={() => refresh(parent)}>
              <ArrowUpFromLine size={14} />
              <span>..</span>
            </li>
          )}
          {err && (
            <li className="list-empty" style={{ color: 'var(--danger)' }}>
              {err}
            </li>
          )}
          {entries.map((e) => (
            <li
              key={e.path}
              className={e.type}
              onClick={() => (e.type === 'dir' ? refresh(e.path) : openFile(e.path))}
              onContextMenu={(ev) => {
                ev.preventDefault()
                deleteEntry(e.path)
              }}
              title="右键删除"
            >
              {e.type === 'dir' ? <Folder size={14} /> : <File size={14} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.name}
              </span>
              {e.size != null && <span className="meta">{formatSize(e.size)}</span>}
            </li>
          ))}
        </ul>
      </aside>

      <div className="editor-pane">
        {openFiles.length > 0 && (
          <div className="editor-tabs">
            {openFiles.map((f) => (
              <div
                key={f.path}
                className={`etab ${f.path === activePath ? 'active' : ''}`}
                onClick={() => setActivePath(f.path)}
              >
                {f.dirty && <span className="dirty">●</span>}
                <span>{f.path.split('/').pop()}</span>
                <span
                  className="close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeFile(f.path)
                  }}
                >
                  <X size={12} />
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="editor-host">
          {!active && (
            <div className="editor-placeholder">
              <File />
              <div>左侧选择文件打开</div>
            </div>
          )}
          {active && (
            <Editor
              path={active.path}
              defaultLanguage={active.language}
              language={active.language}
              value={active.content}
              onChange={(v) => updateContent(active.path, v ?? '')}
              theme="vs-dark"
              options={{
                fontSize: 13,
                minimap: { enabled: false },
                automaticLayout: true,
                wordWrap: 'on',
                padding: { top: 12 },
                fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                scrollbar: { useShadows: false },
              }}
              onMount={(editor, monaco) => {
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                  void saveActive()
                })
              }}
            />
          )}
        </div>
        {active && (
          <div className="editor-actions">
            <button
              className="btn primary"
              onClick={saveActive}
              disabled={!active.dirty}
            >
              <Save size={14} />
              保存
            </button>
            {affectsGateway(active.path) && (
              <button
                className="btn"
                onClick={saveAndReloadGateway}
                disabled={reloading}
                title="保存当前文件并重启 hermes gateway 使改动生效"
              >
                <RotateCw size={14} className={reloading ? 'spin' : ''} />
                {reloading ? '重启中…' : '应用并重启网关'}
              </button>
            )}
            {reloadMsg && (
              <span className={`inline-msg ${reloadMsg.ok ? 'ok' : 'err'}`}>
                {reloadMsg.ok ? (
                  <CheckCircle2 size={13} />
                ) : (
                  <XCircle size={13} />
                )}
                {reloadMsg.text}
              </span>
            )}
            <span className="filepath">{active.path}</span>
            <span className="spacer" />
            <span>{active.language}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function formatSize(n: number) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}
