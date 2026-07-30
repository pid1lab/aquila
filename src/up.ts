/**
 * `aquila up` / `down` / `status` — agent lifecycle.
 *
 * We spawn each session ourselves, detached, with a pty. Two reasons:
 *
 *   1. `claude --bg` cannot host more than one agent. Its daemon pre-warms
 *      "spare" sessions carrying the environment of an earlier invocation, so
 *      agent #2 claims a spare with agent #1's DISCORD_STATE_DIR baked in and
 *      both bots end up on one token — every message delivered and answered
 *      twice. Not a race; reproduced with a fresh daemon and a 15s gap.
 *   2. Without a tty, `claude` falls back to --print mode and exits immediately
 *      ("Input must be provided either through stdin or as a prompt argument").
 *
 * So: `script` supplies the pty, `detached` puts each agent in its own process
 * group, and we own the environment outright — which also means bun's location
 * is our problem to solve rather than a landmine in the daemon's PATH.
 *
 * `up` returns as soon as the sessions are spawned; agents outlive the shell.
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, openSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig, type Agent, type Config } from './config.ts'

const CHANNEL_PLUGIN = 'plugin:discord@claude-plugins-official'

// ---------------------------------------------------------------------------
// Process inspection (Linux /proc; degrades to "unknown" elsewhere)
// ---------------------------------------------------------------------------

const HAS_PROC = (() => {
  try {
    accessSync('/proc/self/cmdline', constants.R_OK)
    return true
  } catch {
    return false
  }
})()

function cmdlineOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
  } catch {
    return ''
  }
}

function envOf(pid: number, key: string): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, 'utf8')
    for (const entry of raw.split('\0')) {
      if (entry.startsWith(`${key}=`)) return entry.slice(key.length + 1)
    }
  } catch {
    /* not ours to read, or gone */
  }
  return undefined
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Is this pid still *our* agent, rather than a recycled pid pointing at some
 * unrelated process? `down` sends signals to a process group, so guessing wrong
 * would kill something innocent.
 */
function isAgentProcess(pid: number, stateDir: string): boolean {
  if (!alive(pid)) return false
  if (!HAS_PROC) return true // can't verify; caller degrades gracefully
  const cmd = cmdlineOf(pid)
  if (!cmd.includes('claude') && !cmd.includes('script')) return false
  return envOf(pid, 'DISCORD_STATE_DIR') === stateDir
}

/** Find the plugin's gateway process for a given agent, if it has connected. */
function gatewayPidFor(stateDir: string): number | undefined {
  if (!HAS_PROC) return undefined
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry)
    if (!Number.isInteger(pid)) continue
    const cmd = cmdlineOf(pid)
    if (!cmd.includes('server.ts')) continue
    if (envOf(pid, 'DISCORD_STATE_DIR') === stateDir) return pid
  }
  return undefined
}

// ---------------------------------------------------------------------------
// bun
// ---------------------------------------------------------------------------

/**
 * The channel plugin's .mcp.json runs `bun`. Since we build the child's PATH,
 * we just need to locate bun and put its directory on that PATH.
 *
 * Getting this wrong fails *silently*: the session still prints its "channels"
 * banner while nothing is listening and the bot never comes online. Refuse to
 * launch rather than start a mute agent.
 */
function findBun(): string | undefined {
  const home = homedir()
  const candidates = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    join(home, '.bun', 'bin'),
    join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
  ]
  for (const dir of candidates) {
    const p = join(dir, 'bun')
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

function shellQuote(parts: string[]): string {
  return parts.map(p => (/^[\w./:@=-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(' ')
}

function logPathFor(agent: Agent): string {
  return join(agent.stateDir, 'session.log')
}

function spawnAgent(agent: Agent, bunDir: string): number | undefined {
  const inner = shellQuote(['claude', '--channels', CHANNEL_PLUGIN])
  const log = openSync(logPathFor(agent), 'a', 0o600)

  const child = spawn('script', ['-qfec', inner, '/dev/null'], {
    cwd: agent.path,
    env: {
      ...process.env,
      PATH: `${bunDir}:${process.env.PATH ?? ''}`,
      DISCORD_STATE_DIR: agent.stateDir,
    },
    detached: true, // own process group, so it outlives this shell
    stdio: ['ignore', log, log],
  })
  child.unref()
  return child.pid
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Wait for the agent's Discord gateway to actually come up. */
async function waitForGateway(agent: Agent, timeoutMs = 45_000): Promise<boolean> {
  if (!HAS_PROC) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (gatewayPidFor(agent.stateDir)) return true
    await sleep(1_500)
  }
  return false
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function resolveTargets(config: Config, names: string[]): Agent[] | string {
  if (!names.length) return config.agents
  const targets: Agent[] = []
  for (const name of names) {
    const agent = config.agents.find(a => a.name === name)
    if (!agent) return `Unknown agent "${name}". Known: ${config.agents.map(a => a.name).join(', ')}`
    targets.push(agent)
  }
  return targets
}

export async function runUp(names: string[]): Promise<number> {
  const config = await loadConfig()
  if (!config.agents.length) {
    console.log('\nNo agents configured. Run `aquila init <agent...>` first.\n')
    return 1
  }

  const targets = resolveTargets(config, names)
  if (typeof targets === 'string') {
    console.error(targets)
    return 1
  }

  const bun = findBun()
  if (!bun) {
    console.error('\n  ✗ bun is not installed, and the discord channel plugin needs it.')
    console.error('    Install it with:  curl -fsSL https://bun.sh/install | bash\n')
    return 1
  }
  const bunDir = bun.slice(0, bun.lastIndexOf('/'))

  console.log()
  const pending: Agent[] = []

  for (const agent of targets) {
    // Two sessions on one token would both receive every message and both reply.
    if (agent.pid && isAgentProcess(agent.pid, agent.stateDir)) {
      console.log(`  · ${agent.name} already running (pid ${agent.pid})`)
      continue
    }

    const pid = spawnAgent(agent, bunDir)
    if (!pid) {
      console.error(`  ✗ ${agent.name}: failed to spawn`)
      continue
    }
    agent.pid = pid
    pending.push(agent)
    console.log(`  · ${agent.name} starting (pid ${pid})`)
  }

  await saveConfig(config)

  // Verify each gateway actually connected. This is the failure we care about:
  // a session that starts fine, prints its channels banner, and is deaf.
  for (const agent of pending) {
    const ok = await waitForGateway(agent)
    if (ok) {
      console.log(`  ✓ ${agent.name} connected  →  #${agent.name}`)
    } else {
      console.log(`  ! ${agent.name} started but its gateway never came up`)
      console.log(`    check ${logPathFor(agent)}`)
    }
  }

  if (pending.length) {
    console.log(`\n  Agents keep running after this shell exits.`)
    console.log(`  Stop with:  aquila down\n`)
  } else {
    console.log()
  }
  return 0
}

export async function runDown(names: string[]): Promise<number> {
  const config = await loadConfig()
  const targets = resolveTargets(config, names)
  if (typeof targets === 'string') {
    console.error(targets)
    return 1
  }

  console.log()
  let stopped = 0
  for (const agent of targets) {
    if (!agent.pid) {
      console.log(`  · ${agent.name} not running`)
      continue
    }
    if (!isAgentProcess(agent.pid, agent.stateDir)) {
      console.log(`  · ${agent.name} not running (stale pid ${agent.pid})`)
      delete agent.pid
      continue
    }
    try {
      // Negative pid = the whole process group, so `script` and claude both go.
      process.kill(-agent.pid, 'SIGTERM')
      console.log(`  ✓ ${agent.name} stopped`)
      stopped++
    } catch (err) {
      console.log(`  ✗ ${agent.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    delete agent.pid
  }

  await saveConfig(config)
  console.log(stopped ? `\n  ${stopped} agent(s) stopped.\n` : '\n')
  return 0
}

export async function runStatus(): Promise<number> {
  const config = await loadConfig()

  if (!config.agents.length) {
    console.log('\nNo agents configured. Run `aquila init <agent...>` to get started.\n')
    return 0
  }

  console.log(`\nserver:  ${config.guildId ?? '(none)'}`)
  console.log(`owner:   ${config.ownerId ?? '(not captured)'}\n`)
  const rows = config.agents.map(agent => {
    const running = agent.pid ? isAgentProcess(agent.pid, agent.stateDir) : false
    const gateway = running ? gatewayPidFor(agent.stateDir) : undefined
    return {
      name: agent.name,
      channel: `#${agent.name}`,
      state: !running
        ? 'stopped'
        : gateway
          ? `connected · pid ${agent.pid}`
          : `no gateway · pid ${agent.pid}`,
      path: agent.path,
    }
  })

  // Size each column to its widest value so nothing runs together.
  const w = (key: 'name' | 'channel' | 'state', header: string) =>
    Math.max(header.length, ...rows.map(r => r[key].length)) + 2

  const wName = w('name', 'AGENT')
  const wChan = w('channel', 'CHANNEL')
  const wState = w('state', 'STATE')

  console.log(
    `  ${'AGENT'.padEnd(wName)}${'CHANNEL'.padEnd(wChan)}${'STATE'.padEnd(wState)}PATH`,
  )
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(wName)}${r.channel.padEnd(wChan)}${r.state.padEnd(wState)}${r.path}`)
  }
  console.log()
  return 0
}
