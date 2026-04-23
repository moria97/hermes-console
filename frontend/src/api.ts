export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number | null
  mtime?: number | null
}

export interface BailianConfig {
  api_key: string
  base_url: string
  default_model: string
  enabled: boolean
}

export interface FeishuConfig {
  app_id: string
  app_secret: string
  enabled: boolean
}

export interface DingtalkConfig {
  client_id: string
  client_secret: string
  enabled: boolean
}

export interface ConsoleSettings {
  bailian: BailianConfig
  feishu: FeishuConfig
  dingtalk: DingtalkConfig
}

export interface HealthInfo {
  console: string
  gateway: string
  dashboard: string
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`[${r.status}] ${await r.text()}`)
  return r.json() as Promise<T>
}

export const api = {
  health: () => fetch('/api/console/health').then(j<HealthInfo>),

  getSettings: () => fetch('/api/console/settings').then(j<ConsoleSettings>),
  saveSettings: (body: ConsoleSettings) =>
    fetch('/api/console/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j<ConsoleSettings>),
  testBailian: (cfg: BailianConfig) =>
    fetch('/api/console/settings/test-bailian', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    }).then(j<{ ok: boolean; models: string[] }>),
  reloadGateway: () =>
    fetch('/api/console/settings/reload-gateway', { method: 'POST' }).then(
      j<{ reloaded: boolean; endpoint?: string; hint?: string }>,
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
