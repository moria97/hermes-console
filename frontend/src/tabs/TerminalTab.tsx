import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'

interface Props {
  visible: boolean
}

export default function TerminalTab({ visible }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!hostRef.current) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      // GitHub-dark-style ANSI palette with our Spotify-green accent. Keeps
      // bash prompts, ls colors, git diffs readable without eye-searing white.
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#39d98a',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(57, 217, 138, 0.25)',
        black: '#484f58',
        red: '#ff7b72',
        green: '#39d98a',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(hostRef.current)
    try {
      fit.fit()
    } catch {
      /* host not mounted yet */
    }

    termRef.current = term
    fitRef.current = fit

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/api/console/terminal?cols=${term.cols}&rows=${term.rows}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => term.write('\x1b[32m[connected]\x1b[0m\r\n')
    ws.onclose = () => term.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n')
    ws.onerror = () => term.write('\r\n\x1b[31m[error]\x1b[0m\r\n')
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'output') {
          const bin = atob(msg.data)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          term.write(bytes)
        } else if (msg.type === 'exit') {
          term.write('\r\n\x1b[33m[session ended]\x1b[0m\r\n')
        } else if (msg.type === 'error') {
          term.write(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m\r\n`)
        }
      } catch {
        /* ignore */
      }
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })

    const onResize = () => {
      try {
        fit.fit()
      } catch {
        /* not visible */
      }
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      ws.close()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
  }, [])

  // Refit whenever the tab becomes visible (hidden panes have zero size).
  useEffect(() => {
    if (visible && fitRef.current) {
      // Wait a tick so the hidden=false layout has settled.
      const id = setTimeout(() => {
        try {
          fitRef.current!.fit()
        } catch {
          /* ignore */
        }
      }, 30)
      return () => clearTimeout(id)
    }
  }, [visible])

  return (
    <div className="terminal-wrap">
      <div className="terminal-window">
        <div className="terminal-titlebar">
          <div className="traffic-lights">
            <span />
            <span />
            <span />
          </div>
          <span className="terminal-title">bash — /mnt/data</span>
        </div>
        <div className="terminal-host" ref={hostRef} />
      </div>
    </div>
  )
}
