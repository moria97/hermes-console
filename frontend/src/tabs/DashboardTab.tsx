// Hermes' built-in dashboard SPA, embedded in an iframe. The console
// FastAPI proxy at /api/dashboard/ rewrites the dashboard's hardcoded
// absolute paths (/assets/*, /favicon.ico) and injects a fetch/XHR shim so
// the SPA can run unchanged inside our origin — see http_proxy.py.

interface DashboardTabProps {
  // Forces a fresh load each time the user switches into the tab; without
  // this, sitting in another tab for hours would leave the iframe with
  // stale state. Bumping the key remounts the iframe.
  visible: boolean
}

export default function DashboardTab({ visible }: DashboardTabProps) {
  if (!visible) return null
  return (
    <iframe
      className="dashboard-iframe"
      src="/api/dashboard/"
      title="Hermes Dashboard"
      // allow-same-origin is required because the SPA reads
      // window.__HERMES_SESSION_TOKEN__ from its own document and uses
      // localStorage. allow-popups lets the dashboard open external links
      // (e.g. provider docs) in new tabs.
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
    />
  )
}
