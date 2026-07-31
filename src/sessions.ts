/**
 * `aquila sessions` / `bind` — which conversation each bot is driving.
 *
 * An agent is the durable thing: a bot, a channel, a working directory. A
 * Claude Code session is a conversation it happens to be having. Those were
 * previously the same object by accident — every `up` started a fresh session
 * and the old conversation was simply abandoned, so a restart meant the bot
 * forgot everything.
 *
 * Aquila mints the session id itself rather than discovering it afterwards:
 * `claude --session-id <uuid>` accepts an id we generate and writes the
 * transcript to `<uuid>.jsonl`, and `--resume <uuid>` reuses that same id
 * instead of forking a new one. So the mapping is a pointer we own, and
 * repointing it is just editing config.
 *
 * Transcripts live in ~/.claude/projects/<encoded-workdir>/. The encoding is
 * Claude Code's, not ours, so we verify our guess against the `cwd` recorded
 * inside the transcripts rather than trusting the substitution.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { loadConfig, saveConfig, type Agent } from './config.ts'

const PROJECTS = join(homedir(), '.claude', 'projects')

export interface Session {
  id: string
  /** Last write — when the conversation was last active. */
  updated: Date
  bytes: number
  /** User and assistant messages; the rest of the JSONL is bookkeeping. */
  turns: number
  /** First thing the human said, for recognising the conversation. */
  preview: string
}

/**
 * Claude Code's directory name for a working directory.
 *
 * A plain character substitution, which is why `/tmp/x/-home-y` collapses to
 * `-tmp-x--home-y`. Treated as a guess: `transcriptDir` falls back to a scan
 * when the guess misses, so an encoding change breaks nothing.
 */
function encode(workdir: string): string {
  return workdir.replace(/[/.]/g, '-')
}

/** Pull the working directory a transcript belongs to, from the first entry that names one. */
async function cwdOf(file: string): Promise<string | undefined> {
  const text = await Bun.file(file).text().catch(() => '')
  for (const line of text.split('\n')) {
    if (!line.includes('"cwd"')) continue
    try {
      const cwd = (JSON.parse(line) as { cwd?: string }).cwd
      if (cwd) return cwd
    } catch {
      /* partial write at the tail; keep looking */
    }
  }
  return undefined
}

/** The transcript directory for a working directory, or undefined if it has none yet. */
export async function transcriptDir(workdir: string): Promise<string | undefined> {
  const guess = join(PROJECTS, encode(workdir))
  try {
    await readdir(guess)
    return guess
  } catch {
    /* guess missed — fall through to the scan */
  }

  let dirs: string[]
  try {
    dirs = await readdir(PROJECTS)
  } catch {
    return undefined
  }
  for (const dir of dirs) {
    const full = join(PROJECTS, dir)
    let files: string[]
    try {
      files = (await readdir(full)).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    if (!files.length) continue
    if ((await cwdOf(join(full, files[0]!))) === workdir) return full
  }
  return undefined
}

function previewOf(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map(part =>
              part && typeof part === 'object' && 'text' in part ? String(part.text) : '',
            )
            .join(' ')
        : ''
  // Discord arrives wrapped: <channel ...>\nwhat they typed\n</channel>
  const inner = /<channel\b[^>]*>([\s\S]*?)<\/channel>/.exec(text)
  return (inner?.[1] ?? text).replace(/\s+/g, ' ').trim()
}

/** Every conversation recorded for this working directory, newest first. */
export async function listSessions(workdir: string): Promise<Session[]> {
  const dir = await transcriptDir(workdir)
  if (!dir) return []

  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.jsonl'))
  } catch {
    return []
  }

  const sessions: Session[] = []
  for (const file of files) {
    const path = join(dir, file)
    const info = await stat(path).catch(() => undefined)
    if (!info) continue

    let turns = 0
    let preview = ''
    const text = await Bun.file(path).text().catch(() => '')
    for (const line of text.split('\n')) {
      if (!line) continue
      let entry: { type?: string; message?: { content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      turns++
      if (!preview && entry.type === 'user') preview = previewOf(entry.message?.content)
    }

    sessions.push({
      id: basename(file, '.jsonl'),
      updated: info.mtime,
      bytes: info.size,
      turns,
      preview,
    })
  }
  return sessions.sort((a, b) => b.updated.getTime() - a.updated.getTime())
}

export async function sessionExists(workdir: string, id: string): Promise<boolean> {
  const dir = await transcriptDir(workdir)
  if (!dir) return false
  return Bun.file(join(dir, `${id}.jsonl`)).exists()
}

/**
 * The flags that put a spawned session on the agent's conversation.
 *
 * Mutates `agent.sessionId` when it mints one; the caller persists it.
 */
export async function sessionArgsFor(agent: Agent, fresh = false): Promise<string[]> {
  if (fresh || !agent.sessionId) {
    agent.sessionId = crypto.randomUUID()
    return ['--session-id', agent.sessionId]
  }
  if (await sessionExists(agent.path, agent.sessionId)) return ['--resume', agent.sessionId]
  // Bound to an id with no transcript behind it — a conversation that was never
  // started, or whose file was deleted. Keep the identity, start it fresh.
  return ['--session-id', agent.sessionId]
}

function ago(then: Date): string {
  const mins = Math.max(0, Math.round((Date.now() - then.getTime()) / 60_000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}K` : `${(bytes / 1048576).toFixed(1)}M`
}

export async function runSessions(names: string[]): Promise<number> {
  const config = await loadConfig()
  if (!config.agents.length) {
    console.log('\nNo agents configured. Run `aquila init <agent...>` first.\n')
    return 1
  }

  const unknown = names.filter(n => !config.agents.some(a => a.name === n))
  if (unknown.length) {
    console.error(`\n  ✗ Unknown agent${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n`)
    return 1
  }
  const targets = names.length ? config.agents.filter(a => names.includes(a.name)) : config.agents

  for (const agent of targets) {
    console.log(`\n  ${agent.name}  →  ${agent.path}\n`)
    const sessions = await listSessions(agent.path)
    if (!sessions.length) {
      console.log('    (no conversations yet)')
      continue
    }
    for (const s of sessions) {
      const mark = s.id === agent.sessionId ? '●' : ' '
      const line =
        `    ${mark} ${s.id.slice(0, 8)}  ` +
        `${String(s.turns).padStart(4)} turns  ` +
        `${size(s.bytes).padStart(5)}  ` +
        `${ago(s.updated).padStart(8)}  `
      console.log(line + (s.preview ? `"${s.preview.slice(0, 44)}"` : ''))
    }
  }
  console.log('\n  ● is the conversation the bot is driving.')
  console.log('  Repoint it with `aquila bind <agent> <session-id>`.\n')
  return 0
}

export async function runBind(args: string[], options: { fresh?: boolean } = {}): Promise<number> {
  const [name, target] = args
  if (!name || (!target && !options.fresh)) {
    console.error('usage: aquila bind <agent> <session-id>')
    console.error('       aquila bind <agent> --new')
    return 1
  }

  const config = await loadConfig()
  const agent = config.agents.find(a => a.name === name)
  if (!agent) {
    console.error(`\n  ✗ Unknown agent "${name}".\n`)
    return 1
  }

  if (options.fresh) {
    agent.sessionId = crypto.randomUUID()
    await saveConfig(config)
    console.log(`\n  ${agent.name} will start a new conversation on next start.\n`)
    return 0
  }

  // Accept an abbreviated id, the way it is printed by `aquila sessions`.
  const sessions = await listSessions(agent.path)
  const matches = sessions.filter(s => s.id === target || s.id.startsWith(target!))
  if (!matches.length) {
    console.error(`\n  ✗ No conversation in ${agent.path} matches "${target}".\n`)
    console.error(`    List them with:  aquila sessions ${agent.name}\n`)
    return 1
  }
  if (matches.length > 1) {
    console.error(`\n  ✗ "${target}" matches ${matches.length} conversations:\n`)
    for (const m of matches) console.error(`      ${m.id}`)
    console.error('\n    Use more of the id.\n')
    return 1
  }

  const chosen = matches[0]!
  agent.sessionId = chosen.id
  await saveConfig(config)

  console.log(`\n  ${agent.name} → ${chosen.id}`)
  if (chosen.preview) console.log(`  "${chosen.preview.slice(0, 60)}"`)
  console.log(
    `\n  ${chosen.turns} turns of history, last active ${ago(chosen.updated)}.` +
      '\n  The session is fixed at spawn, so this takes effect on restart:' +
      `\n\n      aquila down ${agent.name} && aquila up ${agent.name}\n`,
  )
  return 0
}
