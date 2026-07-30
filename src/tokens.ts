/**
 * Token collection — the only part of `aquila init` the user drives by hand.
 *
 * Two front ends, one shape of result. Terminal prompts are the default so SSH
 * and headless boxes always work; `--web` serves a form on localhost for people
 * who already have the Developer Portal open in a browser and would rather not
 * alt-tab N times.
 *
 * Both validate every token against Discord as it arrives, so a typo or a
 * half-copied token is caught at paste time rather than three steps later.
 */

import { createServer } from 'node:http'
import { getApplication, getBotUser } from './discord/provision.ts'

export interface CollectedToken {
  agent: string
  token: string
  applicationId: string
  appName: string
  botUserId: string
}

export const PORTAL_URL = 'https://discord.com/developers/applications'

/** Validate a token by identifying the app behind it. Throws if Discord says no. */
export async function identify(agent: string, token: string): Promise<CollectedToken> {
  const [app, bot] = await Promise.all([getApplication(token), getBotUser(token)])
  return {
    agent,
    token,
    applicationId: app.id,
    appName: app.name,
    botUserId: bot.id,
  }
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/** Read a line without echoing it. Handles paste, backspace, and ^C. */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) {
      reject(new Error('Not a TTY — use --web, or pipe tokens in another way.'))
      return
    }

    process.stdout.write(label)
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let buffer = ''
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
    }

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolve(buffer.trim())
          return
        }
        if (char === '\u0003') {
          cleanup()
          process.stdout.write('\n')
          reject(new Error('cancelled'))
          return
        }
        if (char === '\u007f' || char === '\b') {
          if (buffer.length) {
            buffer = buffer.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        buffer += char
        process.stdout.write('•')
      }
    }

    stdin.on('data', onData)
  })
}

export async function collectViaTerminal(agents: string[]): Promise<CollectedToken[]> {
  console.log(`\n  Create ${agents.length} application(s) at\n  ${PORTAL_URL}`)
  console.log(`  (New Application → name it → Bot → Reset Token → copy)\n`)

  const collected: CollectedToken[] = []
  for (const agent of agents) {
    for (;;) {
      const token = await promptHidden(`  ${agent.padEnd(12)} token › `)
      if (!token) {
        console.log(`  ${''.padEnd(12)} (empty — paste the token, or ^C to abort)`)
        continue
      }
      try {
        const result = await identify(agent, token)
        console.log(`  ${''.padEnd(12)} ✓ "${result.appName}"`)
        collected.push(result)
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`  ${''.padEnd(12)} ✗ ${msg} — try again`)
      }
    }
  }
  return collected
}

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

function page(agents: string[]): string {
  const rows = agents
    .map(
      a => `
      <label class="row" data-agent="${a}">
        <span class="name">${a}</span>
        <input type="password" autocomplete="off" spellcheck="false" placeholder="paste bot token" />
        <span class="state"></span>
      </label>`,
    )
    .join('')

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aquila setup</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --mut:#666; --line:#ddd; --ok:#137333; --bad:#c5221f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#e6e6e6; --mut:#9aa0a6; --line:#2c2f35; --ok:#6dd58c; --bad:#f28b82; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2.5rem 1.25rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  main { max-width: 40rem; margin: 0 auto; }
  h1 { font-size:1.35rem; margin:0 0 .35rem; }
  p { color:var(--mut); margin:0 0 1.75rem; }
  a { color:inherit; }
  .row { display:grid; grid-template-columns:9rem 1fr 5rem; gap:.75rem; align-items:center;
         padding:.6rem 0; border-top:1px solid var(--line); }
  .name { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  input { width:100%; padding:.55rem .7rem; border:1px solid var(--line); border-radius:6px;
          background:transparent; color:inherit; font-family:ui-monospace,monospace; font-size:.85rem; }
  input:focus { outline:2px solid #6a8fff; outline-offset:1px; }
  .state { font-size:.8rem; text-align:right; color:var(--mut); }
  .state.ok { color:var(--ok); } .state.bad { color:var(--bad); }
  button { margin-top:1.75rem; width:100%; padding:.75rem; border:0; border-radius:6px;
           background:#3b5bdb; color:#fff; font-size:.95rem; cursor:pointer; }
  button:disabled { opacity:.4; cursor:not-allowed; }
  footer { margin-top:1.5rem; color:var(--mut); font-size:.8rem; }
</style>
<main>
  <h1>Aquila setup</h1>
  <p>Create one application per agent at
     <a href="${PORTAL_URL}" target="_blank" rel="noreferrer">the Developer Portal</a>,
     then paste each bot token below. Order doesn't matter.</p>
  <form id="f">${rows}</form>
  <button id="go" disabled>Provision ${agents.length} agent${agents.length === 1 ? '' : 's'}</button>
  <footer>Tokens go straight to this local process and are written to
          <code>~/.aquila/agents/&lt;name&gt;/.env</code> with mode 0600. Nothing else sees them.</footer>
</main>
<script>
  const rows = [...document.querySelectorAll('.row')]
  const go = document.getElementById('go')
  const valid = new Map()

  const refresh = () => { go.disabled = valid.size !== rows.length }

  for (const row of rows) {
    const agent = row.dataset.agent
    const input = row.querySelector('input')
    const state = row.querySelector('.state')
    let seq = 0

    const check = async () => {
      const token = input.value.trim()
      valid.delete(agent); refresh()
      if (!token) { state.className = 'state'; state.textContent = ''; return }
      const mine = ++seq
      state.className = 'state'; state.textContent = 'checking…'
      try {
        const res = await fetch('/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent, token }),
        })
        const data = await res.json()
        if (mine !== seq) return
        if (data.ok) {
          state.className = 'state ok'; state.textContent = data.appName
          valid.set(agent, token)
        } else {
          state.className = 'state bad'; state.textContent = data.error || 'invalid'
        }
      } catch {
        if (mine === seq) { state.className = 'state bad'; state.textContent = 'error' }
      }
      refresh()
    }

    input.addEventListener('input', () => { clearTimeout(input._t); input._t = setTimeout(check, 400) })
    input.addEventListener('paste', () => setTimeout(check, 0))
  }

  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Provisioning…'
    await fetch('/done', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(valid)),
    })
    document.body.innerHTML =
      '<main><h1>Done — return to your terminal.</h1></main>'
  })
</script>`
}

export function collectViaWeb(agents: string[], port = 7777): Promise<CollectedToken[]> {
  return new Promise((resolve, reject) => {
    const validated = new Map<string, CollectedToken>()

    const server = createServer((req, res) => {
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }

      if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page(agents))
        return
      }

      if (req.method !== 'POST') {
        json(404, { error: 'not found' })
        return
      }

      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', async () => {
        let parsed: Record<string, string>
        try {
          parsed = JSON.parse(body || '{}')
        } catch {
          json(400, { error: 'bad json' })
          return
        }

        if (req.url === '/validate') {
          const agent = parsed.agent
          const token = parsed.token
          if (!agent || !token) {
            json(400, { ok: false, error: 'missing field' })
            return
          }
          try {
            const result = await identify(agent, token)
            validated.set(agent, result)
            json(200, { ok: true, appName: result.appName })
          } catch (err) {
            validated.delete(agent)
            json(200, { ok: false, error: err instanceof Error ? err.message : 'invalid' })
          }
          return
        }

        if (req.url === '/done') {
          const ordered = agents.map(a => validated.get(a)).filter((t): t is CollectedToken => !!t)
          if (ordered.length !== agents.length) {
            json(400, { error: 'not all tokens validated' })
            return
          }
          json(200, { ok: true })
          server.close()
          resolve(ordered)
          return
        }

        json(404, { error: 'not found' })
      })
    })

    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${port}`
      console.log(`\n  Portal: ${PORTAL_URL}`)
      console.log(`  Paste tokens at: ${url}\n`)
      console.log(`  Waiting for ${agents.length} token(s)...`)
    })
  })
}
