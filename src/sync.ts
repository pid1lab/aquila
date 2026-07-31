/**
 * `aquila sync` — channel discovery.
 *
 * The channel plugin gates guild channels behind an explicit per-channel opt-in
 * (`groups` in access.json). A channel that isn't opted in is dropped silently:
 * no reply, no error, not even the ack reaction, because that fires after the
 * gate. From the outside it is indistinguishable from a dead bot. Aquila seeds
 * each agent with exactly one entry — its own channel — so a shared channel you
 * create by hand is invisible to every agent until someone hand-edits JSON in
 * each state dir. This closes that gap.
 *
 * Detection is a probe, not a calculation. `GET /channels/{id}` answers 403
 * without VIEW_CHANNEL and 200 with it, which is ground truth from the same
 * permission code that decides whether the gateway will deliver the message at
 * all. Computing it locally would mean reimplementing role ordering, category
 * inheritance, and admin bypass — and being quietly wrong about them. The
 * listing endpoint is no substitute: `GET /guilds/{id}/channels` returns every
 * channel's metadata regardless of access, so a bot can enumerate rooms it
 * cannot read.
 *
 * Discovered channels get `requireMention: true`, unlike an agent's own
 * channel, because in a room several agents share you address one at a time.
 * They keep `allowFrom: [ownerId]`, so discovery widens *where* you can summon
 * an agent without widening *who* can drive it: a stranger in a public channel
 * is dropped before the mention check ever runs.
 */

import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { anyToken, loadConfig, readAgentToken, saveConfig, type Agent, type Config } from './config.ts'
import { listChannels, type Channel } from './discord/provision.ts'
import { DiscordError, rest } from './discord/rest.ts'
import type { Reach } from './brief.ts'

/** Only the parts of access.json we touch; everything else is preserved verbatim. */
interface GroupPolicy {
  requireMention?: boolean
  allowFrom?: string[]
}
interface AccessFile {
  groups?: Record<string, GroupPolicy>
  [key: string]: unknown
}

/**
 * Which channels Aquila opted this agent into.
 *
 * Kept beside access.json rather than inside it: the plugin owns that file's
 * schema, and an unrecognised key there is a bet on how its parser behaves.
 * The record is what lets a later sync retract its own entries without
 * touching a group the user added by hand.
 */
const AUTO_FILE = 'auto-channels.json'

export interface AgentSync {
  agent: Agent
  added: Channel[]
  removed: string[]
  /** Managed channels whose trigger list was brought back in line with config. */
  retuned: string[]
  /** Set when this agent could not be synced; the others still are. */
  error?: string
}

/**
 * Who may trigger an agent in a shared channel.
 *
 * An empty list is not "nobody" — the plugin reads it as "any member", still
 * subject to the mention check. That is exactly what `guests: 'anyone'` wants,
 * and why the owner-only case has to name the owner explicitly.
 */
export function triggerAllowFrom(config: Config): string[] {
  if (config.guests === 'anyone') return []
  const owner = config.ownerId ? [config.ownerId] : []
  return [...new Set([...owner, ...(config.guests ?? [])])]
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every(v => b.includes(v))
}

async function readAccess(stateDir: string): Promise<AccessFile> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, 'access.json'), 'utf8')) as unknown
    if (parsed && typeof parsed === 'object') return parsed as AccessFile
  } catch {
    /* absent or corrupt — the plugin rebuilds it, and we shouldn't clobber it */
  }
  return {}
}

async function readAuto(stateDir: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, AUTO_FILE), 'utf8')) as {
      channels?: unknown
    }
    if (Array.isArray(parsed.channels)) return new Set(parsed.channels.filter(c => typeof c === 'string'))
  } catch {
    /* first run */
  }
  return new Set()
}

/**
 * Can this bot see the channel?
 *
 * 404 counts as no: the channel was deleted between the listing and the probe,
 * which for our purposes is the same as being locked out of it.
 */
export async function canView(token: string, channelId: string): Promise<boolean> {
  try {
    await rest(token, 'GET', `/channels/${channelId}`)
    return true
  } catch (err) {
    if (err instanceof DiscordError && (err.status === 403 || err.status === 404)) return false
    throw err
  }
}

async function syncAgent(
  agent: Agent,
  config: Config,
  channels: Channel[],
): Promise<AgentSync> {
  const result: AgentSync = { agent, added: [], removed: [], retuned: [] }
  const wanted = triggerAllowFrom(config)

  const token = await readAgentToken(agent.stateDir)
  if (!token) {
    result.error = 'no bot token on disk'
    return result
  }

  // Every agent's own channel is its private line. We skip all of them: an
  // agent must not join another's, and its own entry was seeded at provision
  // time with requireMention:false, which discovery would otherwise overwrite.
  const owned = new Set(config.agents.map(a => a.channelId).filter(Boolean) as string[])
  const candidates = channels.filter(c => !owned.has(c.id))

  const access = await readAccess(agent.stateDir)
  const groups: Record<string, GroupPolicy> = access.groups ?? {}
  const previous = await readAuto(agent.stateDir)

  let visibility: boolean[]
  try {
    visibility = await Promise.all(candidates.map(c => canView(token, c.id)))
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    return result
  }

  const current: string[] = []
  for (const [i, channel] of candidates.entries()) {
    if (!visibility[i]) continue
    const known = channel.id in groups
    // Already configured by hand: leave the user's settings alone, and don't
    // claim it, or a later sync would retract a group we never created.
    if (known && !previous.has(channel.id)) continue

    current.push(channel.id)
    if (!known) {
      groups[channel.id] = { requireMention: true, allowFrom: wanted }
      result.added.push(channel)
      continue
    }
    // Ours already: keep the trigger list in step with `aquila allow`, which is
    // the only way a policy change reaches channels joined on an earlier run.
    // requireMention is left alone — there is no config for it to disagree with.
    const policy = groups[channel.id]!
    if (!sameMembers(policy.allowFrom ?? [], wanted)) {
      policy.allowFrom = [...wanted]
      result.retuned.push(channel.id)
    }
  }

  // Retract our own entries once the bot loses access. Hand-added groups stay
  // even when unreachable — removing them is the user's call, not ours.
  const live = new Set(current)
  for (const id of previous) {
    if (!live.has(id) && id in groups) {
      delete groups[id]
      result.removed.push(id)
    }
  }

  if (result.added.length || result.removed.length || result.retuned.length) {
    access.groups = groups
    await writeFile(
      join(agent.stateDir, 'access.json'),
      JSON.stringify(access, null, 2) + '\n',
      { mode: 0o600 },
    )
  }
  // Written unconditionally: ownership can change without groups changing, as
  // when a channel we track is also present because the user added it.
  await writeFile(
    join(agent.stateDir, AUTO_FILE),
    JSON.stringify({ channels: current }, null, 2) + '\n',
    { mode: 0o600 },
  )

  return result
}

/**
 * Probe every channel for every target agent and update their access files.
 *
 * Agents run in series and channels in parallel, which keeps the burst at one
 * agent's channel count — comfortably inside Discord's global limit, and `rest`
 * honours 429 anyway.
 */
export async function syncChannels(config: Config, targets: Agent[]): Promise<AgentSync[]> {
  if (!config.guildId || !config.ownerId || !targets.length) return []

  // Any token can list the guild's channels; metadata is not access-gated.
  // Prefer the provisioner's since it is the one guaranteed to still be around.
  const order = [
    ...targets.filter(a => a.name === config.provisionerAgent),
    ...targets.filter(a => a.name !== config.provisionerAgent),
  ]
  let channels: Channel[] | undefined
  for (const agent of order) {
    const token = await readAgentToken(agent.stateDir)
    if (!token) continue
    try {
      channels = await listChannels(token, config.guildId)
      break
    } catch {
      /* this bot may have been kicked; try the next */
    }
  }
  if (!channels) return []

  const results: AgentSync[] = []
  for (const agent of targets) {
    results.push(await syncAgent(agent, config, channels))
  }
  return results
}

/**
 * Where each agent can be reached, by name, for the spawn-time briefing.
 *
 * Read from each agent's own access.json rather than from the guild listing:
 * that is the file the plugin gates on, so it is the only honest answer to
 * "which channels will actually reach you". One listing call, shared by all.
 */
export async function reachOf(
  config: Config,
  agents: Agent[],
): Promise<Map<string, Reach>> {
  const out = new Map<string, Reach>()
  if (!config.guildId) return out

  const token = await anyToken(config)
  if (!token) return out

  let names: Map<string, string>
  try {
    names = new Map((await listChannels(token, config.guildId)).map(c => [c.id, c.name]))
  } catch {
    return out
  }

  const owned = new Set(config.agents.map(a => a.channelId).filter(Boolean) as string[])
  for (const agent of agents) {
    const groups = (await readAccess(agent.stateDir)).groups ?? {}
    const shared: string[] = []
    for (const id of Object.keys(groups)) {
      if (owned.has(id)) continue
      const name = names.get(id)
      if (name) shared.push(name)
    }
    out.set(agent.name, {
      own: agent.channelId ? names.get(agent.channelId) : undefined,
      shared: shared.sort(),
    })
  }
  return out
}

/** Did anything actually move? */
export function changedCount(results: AgentSync[]): number {
  return results.reduce((n, r) => n + r.added.length + r.removed.length + r.retuned.length, 0)
}

/** Print only what changed. Silence means every agent was already correct. */
export function reportSync(results: AgentSync[], options: { verbose?: boolean } = {}): void {
  for (const r of results) {
    if (r.error) {
      if (options.verbose) console.log(`  ! ${r.agent.name}: ${r.error}`)
      continue
    }
    for (const channel of r.added) console.log(`  + ${r.agent.name} joined #${channel.name}`)
    for (const id of r.removed) console.log(`  - ${r.agent.name} left ${id} (no longer visible)`)
    if (options.verbose && r.retuned.length) {
      console.log(`  ~ ${r.agent.name}: updated who can trigger it in ${r.retuned.length} channel(s)`)
    }
  }
}

/**
 * Discovery on the way past, for commands that are doing something else.
 *
 * Never fatal: a network blip should not stop `aquila up` from starting agents
 * that would work fine without a channel refresh.
 */
export async function autoSync(config: Config, targets: Agent[]): Promise<void> {
  if (config.autoChannels === false) return
  try {
    const results = await syncChannels(config, targets)
    // Nothing changed is the common case; stay out of the caller's output.
    if (results.some(r => r.added.length || r.removed.length)) reportSync(results)
  } catch {
    /* discovery is a convenience; the command it rode in on still stands */
  }
}

export async function runSync(names: string[], options: { off?: boolean; on?: boolean } = {}): Promise<number> {
  const config = await loadConfig()

  if (options.off || options.on) {
    config.autoChannels = !options.off
    await saveConfig(config)
    console.log(
      options.off
        ? '\n  Automatic channel discovery off. `aquila sync` still works on demand.\n'
        : '\n  Automatic channel discovery on.\n',
    )
    if (options.off) return 0
  }

  if (!config.agents.length) {
    console.log('\nNo agents configured. Run `aquila init <agent...>` first.\n')
    return 1
  }
  if (!config.guildId || !config.ownerId) {
    console.error('\n  ✗ No server on record. Run `aquila init` first.\n')
    return 1
  }

  const targets = names.length
    ? config.agents.filter(a => names.includes(a.name))
    : config.agents
  const unknown = names.filter(n => !config.agents.some(a => a.name === n))
  if (unknown.length) {
    console.error(`\n  ✗ Unknown agent${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n`)
    return 1
  }

  console.log()
  const results = await syncChannels(config, targets)
  reportSync(results, { verbose: true })

  const changed = changedCount(results)
  const failed = results.filter(r => r.error).length

  if (!changed) console.log('  Nothing to change — every agent is already in the channels it can see.')
  console.log(
    changed
      ? '\n  Live now: the plugin re-reads access.json on every message, so\n' +
          '  running agents pick this up without a restart.\n'
      : '',
  )
  return failed && !changed ? 1 : 0
}
