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
import {
  accessSync,
  constants,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig, type Agent, type Config } from './config.ts'
import { autoSync, reachOf } from './sync.ts'
import { triggerSummary } from './allow.ts'
import { briefingFor, type Reach } from './brief.ts'
import { sessionArgsFor } from './sessions.ts'

const CHANNEL_PLUGIN = 'plugin:discord@claude-plugins-official'
const CLAUDE_CONFIG = join(homedir(), '.claude.json')

// ---------------------------------------------------------------------------
// Workspace trust
// ---------------------------------------------------------------------------

/**
 * Claude Code asks "do you trust the files in this folder?" the first time it
 * runs anywhere new, and blocks on it. In a detached session nobody can see or
 * answer that prompt, so the agent hangs forever at an invisible dialog while
 * looking like it started fine.
 *
 * There is no CLI flag for this — the dialog is only skipped in non-interactive
 * mode (`-p`), which we can't use because the agent must stay resident. So we
 * check first and refuse to launch rather than spawn something that can't work.
 *
 * Returns undefined when we can't tell, in which case we let the launch proceed.
 */
export function isTrusted(path: string): boolean | undefined {
  try {
    const config = JSON.parse(readFileSync(CLAUDE_CONFIG, 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
    }
    if (!config.projects) return undefined
    return config.projects[path]?.hasTrustDialogAccepted === true
  } catch {
    return undefined
  }
}

/**
 * Record trust for a directory, as `aquila up --trust` does.
 *
 * Deliberately NOT automatic: trusting a folder means Claude Code may read,
 * edit, and execute anything in it, which is the user's call to make explicitly
 * rather than a side effect of starting an agent.
 */
export function markTrusted(path: string): boolean {
  try {
    const raw = readFileSync(CLAUDE_CONFIG, 'utf8')
    const config = JSON.parse(raw) as {
      projects?: Record<string, Record<string, unknown>>
    }
    config.projects ??= {}
    config.projects[path] = { ...config.projects[path], hasTrustDialogAccepted: true }
    writeFileSync(CLAUDE_CONFIG, JSON.stringify(config, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

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
export function isAgentProcess(pid: number, stateDir: string): boolean {
  if (!alive(pid)) return false
  if (!HAS_PROC) return true // can't verify; caller degrades gracefully
  const cmd = cmdlineOf(pid)
  if (!cmd.includes('claude') && !cmd.includes('script')) return false
  return envOf(pid, 'DISCORD_STATE_DIR') === stateDir
}

/** Where a running agent actually is, which may differ from config after an edit. */
function actualCwd(pid: number): string | undefined {
  if (!HAS_PROC) return undefined
  // The recorded pid is `script`; the claude session is its child.
  for (const candidate of [...childPids(pid), pid]) {
    try {
      return readlinkSync(`/proc/${candidate}/cwd`)
    } catch {
      /* try the next */
    }
  }
  return undefined
}

function childPids(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
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

/**
 * Environment for an agent, with the launching Claude Code session scrubbed out.
 *
 * `aquila up` is often run from inside Claude Code, and a plain `...process.env`
 * hands the agent that session's identity: CLAUDE_CODE_SESSION_ID, CLAUDE_PID,
 * CLAUDE_CODE_CHILD_SESSION, CLAUDE_EFFORT. The agent then believes it is a
 * child of the launching session — transcript saving silently turns off, effort
 * is inherited, and permission handling follows the parent rather than the
 * agent's own settings. Agents must be independent top-level sessions.
 *
 * ANTHROPIC_* is preserved: that's auth, not session identity.
 */
function agentEnv(agent: Agent, bunDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^CLAUDE/i.test(key)) continue
    env[key] = value
  }
  env.PATH = `${bunDir}:${process.env.PATH ?? ''}`
  env.DISCORD_STATE_DIR = agent.stateDir
  return env
}

function spawnAgent(
  agent: Agent,
  bunDir: string,
  briefing?: string,
  sessionArgs: string[] = [],
): number | undefined {
  // Before claudeArgs, so an explicit flag of the user's own lands after ours
  // rather than being buried by it.
  const inner = shellQuote([
    'claude',
    '--channels',
    CHANNEL_PLUGIN,
    ...sessionArgs,
    ...(briefing ? ['--append-system-prompt', briefing] : []),
    ...(agent.claudeArgs ?? []),
  ])
  const log = openSync(logPathFor(agent), 'a', 0o600)

  const child = spawn('script', ['-qfec', inner, '/dev/null'], {
    cwd: agent.path,
    env: agentEnv(agent, bunDir),
    detached: true, // own process group, so it outlives this shell
    stdio: ['ignore', log, log],
  })
  child.unref()
  return child.pid
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** SIGTERM a process group, wait for it to actually die, escalate if it doesn't. */
async function terminateGroup(pid: number, graceMs = 5_000): Promise<boolean> {
  const groupGone = () => {
    try {
      process.kill(-pid, 0)
      return false
    } catch {
      return true
    }
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return true // already gone
  }

  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (groupGone()) return true
    await sleep(250)
  }

  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    return true
  }
  await sleep(500)
  return groupGone()
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

export async function runUp(
  names: string[],
  options: {
    trust?: boolean
    noAutoChannels?: boolean
    noBrief?: boolean
    newSession?: boolean
  } = {},
): Promise<number> {
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

  // Trust check before anything is spawned — an untrusted directory produces an
  // agent stuck on a dialog nobody can answer.
  const untrusted = targets.filter(a => isTrusted(a.path) === false)
  if (untrusted.length) {
    if (options.trust) {
      for (const agent of untrusted) {
        const ok = markTrusted(agent.path)
        console.log(
          ok
            ? `  ✓ trusted ${agent.path}`
            : `  ✗ could not record trust for ${agent.path}`,
        )
        if (!ok) return 1
      }
    } else {
      console.error('\n  ✗ Claude Code has not been trusted in:\n')
      for (const agent of untrusted) console.error(`      ${agent.path}  (${agent.name})`)
      console.error(
        '\n  It would block on the "do you trust this folder?" prompt, which\n' +
          '  nothing can answer in a detached session.\n\n' +
          '  Either run `claude` once in each directory and accept, or:\n\n' +
          '      aquila up --trust\n\n' +
          '  Trusting a folder lets Claude Code read, edit, and execute files\n' +
          '  there, so it is your call to make explicitly.\n',
      )
      return 1
    }
  }

  console.log()

  // Before spawning, so an agent starts already knowing about a channel you
  // added since last time rather than ignoring it until the next command.
  if (!options.noAutoChannels) await autoSync(config, targets)

  // Who the agent is and who else is here. Best-effort: a failed lookup costs
  // the roster, not the session.
  const reach: Map<string, Reach> = options.noBrief ? new Map() : await reachOf(config, targets)

  const pending: Agent[] = []

  for (const agent of targets) {
    // Two sessions on one token would both receive every message and both reply.
    if (agent.pid && isAgentProcess(agent.pid, agent.stateDir)) {
      console.log(`  · ${agent.name} already running (pid ${agent.pid})`)
      continue
    }

    const brief = reach.get(agent.name)
    // Mints agent.sessionId when absent; saveConfig below persists it.
    const resuming = !options.newSession && agent.sessionId
    const sessionArgs = await sessionArgsFor(agent, options.newSession)
    const pid = spawnAgent(
      agent,
      bunDir,
      brief && briefingFor(agent, config, brief),
      sessionArgs,
    )
    if (!pid) {
      console.error(`  ✗ ${agent.name}: failed to spawn`)
      continue
    }
    agent.pid = pid
    pending.push(agent)
    const how = sessionArgs[0] === '--resume' ? 'resuming' : resuming ? 'restarting' : 'new session'
    console.log(`  · ${agent.name} starting (pid ${pid}, ${how})`)
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
    // Negative pid = the whole process group, so `script` and claude both go.
    // Then confirm: a session sitting on an interactive prompt does not always
    // die promptly, and reporting "stopped" for something still holding a
    // Discord gateway is worse than reporting nothing.
    const gone = await terminateGroup(agent.pid)
    if (gone) {
      console.log(`  ✓ ${agent.name} stopped`)
      stopped++
    } else {
      console.log(`  ✗ ${agent.name}: pid ${agent.pid} survived SIGTERM and SIGKILL`)
    }
    delete agent.pid
  }

  await saveConfig(config)
  console.log(stopped ? `\n  ${stopped} agent(s) stopped.\n` : '\n')
  return 0
}

export async function runStatus(options: { noAutoChannels?: boolean } = {}): Promise<number> {
  const config = await loadConfig()

  if (!config.agents.length) {
    console.log('\nNo agents configured. Run `aquila init <agent...>` to get started.\n')
    return 0
  }

  if (!options.noAutoChannels) await autoSync(config, config.agents)

  console.log(`\nserver:  ${config.guildId ?? '(none)'}`)
  console.log(`owner:   ${config.ownerId ?? '(not captured)'}`)
  console.log(`trigger: ${triggerSummary(config)}\n`)
  const rows = config.agents.map(agent => {
    const running = agent.pid ? isAgentProcess(agent.pid, agent.stateDir) : false
    const gateway = running ? gatewayPidFor(agent.stateDir) : undefined
    // A session's working directory is fixed at spawn, so a config edit leaves
    // the two disagreeing. Say so rather than reporting the config as truth.
    const actual = running && agent.pid ? actualCwd(agent.pid) : undefined
    const moved = actual !== undefined && actual !== agent.path
    return {
      name: agent.name,
      channel: `#${agent.name}`,
      session: agent.sessionId ? agent.sessionId.slice(0, 8) : '—',
      state: !running
        ? 'stopped'
        : gateway
          ? `connected · pid ${agent.pid}`
          : `no gateway · pid ${agent.pid}`,
      path: moved ? `${agent.path}  ⚠ running in ${actual}` : agent.path,
    }
  })

  // Size each column to its widest value so nothing runs together.
  const w = (key: 'name' | 'channel' | 'state' | 'session', header: string) =>
    Math.max(header.length, ...rows.map(r => r[key].length)) + 2

  const wName = w('name', 'AGENT')
  const wChan = w('channel', 'CHANNEL')
  const wState = w('state', 'STATE')
  const wSess = w('session', 'SESSION')

  console.log(
    `  ${'AGENT'.padEnd(wName)}${'CHANNEL'.padEnd(wChan)}${'STATE'.padEnd(wState)}${'SESSION'.padEnd(wSess)}PATH`,
  )
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(wName)}${r.channel.padEnd(wChan)}${r.state.padEnd(wState)}${r.session.padEnd(wSess)}${r.path}`,
    )
  }
  console.log()
  return 0
}
