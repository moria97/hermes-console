export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number | null
  mtime?: number | null
}

export interface ProviderConfig {
  name: string
  // UI preset: "public" | "tokenplan" | "coding" | "custom"
  type: string
  base_url: string
  api_key: string
  models: string[]
}

export interface FeishuConfig {
  app_id: string
  app_secret: string
}

export interface DingtalkConfig {
  client_id: string
  client_secret: string
}

export interface ConsoleSettings {
  providers: ProviderConfig[]
  // Empty strings = no active default → hermes provider falls back to "auto".
  active_provider: string
  active_model: string
  feishu: FeishuConfig
  dingtalk: DingtalkConfig
}

export interface HealthInfo {
  console: string
  gateway: string
  dashboard: string
}

export interface HermesVersion {
  raw: string
  version: string  // "v0.10.0"
  build: string    // "2026.4.16"
}

export interface HermesSessionRow {
  id: string
  source: string | null
  model: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  title: string | null
  preview: string  // first user message, trimmed
}

export interface HermesMessageRow {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string | null
  tool_call_id: string | null
  tool_calls: any  // parsed JSON array (or raw string fallback)
  tool_name: string | null
  timestamp: number
  finish_reason: string | null
  reasoning_content: string | null
}

export interface HermesSessionDetail {
  session: {
    id: string
    model: string | null
    started_at: number
    ended_at: number | null
    message_count: number
    title: string | null
    system_prompt: string | null
    [k: string]: any
  }
  messages: HermesMessageRow[]
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`[${r.status}] ${await r.text()}`)
  return r.json() as Promise<T>
}

export const api = {
  health: () => fetch('/api/console/health').then(j<HealthInfo>),
  version: () => fetch('/api/console/version').then(j<HermesVersion>),

  getSettings: () => fetch('/api/console/settings').then(j<ConsoleSettings>),
  saveSettings: (body: ConsoleSettings) =>
    fetch('/api/console/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j<ConsoleSettings>),
  // mode "fetch" → GET /models (returns list for multi-select).
  // mode "auth"  → POST /chat/completions with a 1-token probe (validates
  //                creds against endpoints that don't expose /models, e.g.
  //                Bailian Coding Plan). `model` is required for "auth".
  testModel: (cfg: {
    api_key: string
    base_url: string
    mode?: 'fetch' | 'auth'
    model?: string
  }) =>
    fetch('/api/console/settings/test-model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    }).then(j<{ ok: boolean; models: string[] }>),
  reloadGateway: () =>
    fetch('/api/console/settings/reload-gateway', { method: 'POST' }).then(
      j<{
        reloaded: boolean
        endpoint?: string
        hint?: string
        old_pid?: number | null
        new_pid?: number | null
      }>,
    ),

  tree: (path = '') =>
    fetch(`/api/console/files/tree?path=${encodeURIComponent(path)}`).then(
      j<{ path: string; entries: FileNode[] }>,
    ),
  read: (path: string) =>
    fetch(`/api/console/files/read?path=${encodeURIComponent(path)}`).then(
      j<{ path: string; content: string; size: number; binary: boolean }>,
    ),
  write: (path: string, content: string) =>
    fetch('/api/console/files/write', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }).then(j<{ path: string; size: number }>),
  mkdir: (path: string) =>
    fetch(`/api/console/files/mkdir?path=${encodeURIComponent(path)}`, {
      method: 'POST',
    }).then(j<{ path: string }>),
  remove: (path: string) =>
    fetch(`/api/console/files?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }).then(j<{ deleted: string }>),

  // Hermes-stored conversation history (read-only mirror of state.db).
  listSessions: (limit = 50) =>
    fetch(`/api/console/sessions?limit=${limit}`).then(j<HermesSessionRow[]>),
  getSession: (id: string) =>
    fetch(`/api/console/sessions/${encodeURIComponent(id)}`).then(j<HermesSessionDetail>),

  // Gateway paths are forwarded 1:1 — same URLs as raw hermes / OpenAI
  // clients. The console backend only strips CSRF-adjacent headers before
  // passing through.
  models: async (): Promise<string[]> => {
    try {
      const r = await fetch('/v1/models')
      if (!r.ok) return []
      const d = await r.json()
      return (d.data ?? []).map((m: any) => m.id as string)
    } catch {
      return []
    }
  },
}
