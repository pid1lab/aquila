/**
 * `aquila allow` — who, besides you, can trigger an agent in a shared channel.
 *
 * This is the one setting in Aquila with real teeth. Triggering an agent means
 * making a Claude Code session on your machine run a turn, so the default is
 * you alone, and widening it is always an explicit act.
 *
 * Everything here speaks in names. Discord's own IDs are 19-digit snowflakes
 * that nobody can check by eye — `allowFrom: ["1021487254104973352"]` is not a
 * security control anyone can audit — so names go in, names come out, and the
 * snowflake stays an implementation detail of access.json.
 */

import { loadConfig, readAgentToken, saveConfig, type Agent, type Config } from './config.ts'
import { fetchUser, label, resolvePerson, type Person } from './discord/people.ts'
import { changedCount, reportSync, syncChannels, triggerAllowFrom } from './sync.ts'

export interface AllowOptions {
  remove?: boolean
  anyone?: boolean
  ownerOnly?: boolean
}

/** Any agent's token can read the member list; prefer one that certainly still exists. */
async function anyToken(config: Config): Promise<string | undefined> {
  const order: Agent[] = [
    ...config.agents.filter(a => a.name === config.provisionerAgent),
    ...config.agents.filter(a => a.name !== config.provisionerAgent),
  ]
  for (const agent of order) {
    const token = await readAgentToken(agent.stateDir)
    if (token) return token
  }
  return undefined
}

async function describe(token: string, config: Config): Promise<void> {
  if (config.guests === 'anyone') {
    console.log('  Anyone in the server can trigger an agent by @mentioning it.')
    return
  }

  const ids = config.guests ?? []
  const owner = config.ownerId ? await fetchUser(token, config.ownerId) : undefined
  console.log(`  ${owner ? label(owner) : (config.ownerId ?? 'you')}  (owner)`)

  for (const id of ids) {
    const person = await fetchUser(token, id)
    console.log(`  ${person ? label(person) : `${id}  (account not found)`}`)
  }
  if (!ids.length) console.log('\n  Nobody else. Add someone with `aquila allow <name>`.')
}

/** Apply the current policy to every managed channel and say what moved. */
async function applyAndReport(config: Config): Promise<void> {
  const results = await syncChannels(config, config.agents)
  reportSync(results, { verbose: true })
  if (changedCount(results)) {
    console.log(
      '\n  Live now: the plugin re-reads access.json on every message, so\n' +
        '  running agents pick this up without a restart.',
    )
  }
}

export async function runAllow(args: string[], options: AllowOptions = {}): Promise<number> {
  const config = await loadConfig()
  if (!config.agents.length) {
    console.log('\nNo agents configured. Run `aquila init <agent...>` first.\n')
    return 1
  }
  if (!config.guildId || !config.ownerId) {
    console.error('\n  ✗ No server on record. Run `aquila init` first.\n')
    return 1
  }

  const token = await anyToken(config)
  if (!token) {
    console.error('\n  ✗ No bot token on disk — cannot look anyone up.\n')
    return 1
  }

  console.log()

  if (options.anyone) {
    config.guests = 'anyone'
    await saveConfig(config)
    console.log('  Anyone in the server can now trigger an agent by @mentioning it.')
    console.log('  Private per-agent channels are unaffected — those stay yours.\n')
    console.log(
      '  Everyone you invite to this server can now make a Claude Code session\n' +
        '  on this machine run a turn. Undo with `aquila allow --owner-only`.\n',
    )
    await applyAndReport(config)
    console.log()
    return 0
  }

  if (options.ownerOnly) {
    config.guests = []
    await saveConfig(config)
    console.log('  Back to you alone. Nobody else can trigger an agent.\n')
    await applyAndReport(config)
    console.log()
    return 0
  }

  if (!args.length) {
    console.log('  Can trigger agents in shared channels:\n')
    await describe(token, config)
    console.log()
    return 0
  }

  // Resolve everything before changing anything, so a typo in the second name
  // doesn't leave the first half applied.
  const resolved: Person[] = []
  for (const input of args) {
    const found = await resolvePerson(token, config.guildId, input)
    if ('person' in found) {
      resolved.push(found.person)
      continue
    }
    if (!found.candidates.length) {
      console.error(`  ✗ No member of this server matches "${input}".\n`)
      console.error('    Search covers @handles, display names and server nicknames.')
      console.error('    A user id works too, if you have it.\n')
      return 1
    }
    console.error(`  ✗ "${input}" matches several people:\n`)
    for (const c of found.candidates) console.error(`      ${label(c)}   ${c.id}`)
    console.error('\n    Use the exact @handle, or the id.\n')
    return 1
  }

  const bots = resolved.filter(p => p.bot)
  if (bots.length) {
    console.error(`  ✗ ${bots.map(label).join(', ')} ${bots.length > 1 ? 'are bots' : 'is a bot'}.\n`)
    console.error('    The plugin drops inbound bot messages outright, so this would')
    console.error('    have no effect. Agents cannot wake each other by design.\n')
    return 1
  }

  if (config.guests === 'anyone' && !options.remove) {
    console.log('  Currently anyone in the server can trigger agents, so this')
    console.log('  changes nothing. Narrow it first with `aquila allow --owner-only`.\n')
    return 1
  }

  const current = new Set(config.guests === 'anyone' ? [] : (config.guests ?? []))

  for (const person of resolved) {
    if (options.remove) {
      if (person.id === config.ownerId) {
        console.error(`  ✗ ${label(person)} is the server owner and always allowed.\n`)
        return 1
      }
      if (!current.delete(person.id)) {
        console.log(`  · ${label(person)} was not on the list`)
      } else {
        console.log(`  - ${label(person)} can no longer trigger agents`)
      }
    } else {
      if (person.id === config.ownerId || current.has(person.id)) {
        console.log(`  · ${label(person)} already could`)
      } else {
        current.add(person.id)
        console.log(`  + ${label(person)} can now trigger agents by @mentioning them`)
      }
    }
  }

  config.guests = [...current]
  await saveConfig(config)
  await applyAndReport(config)
  console.log()
  return 0
}

/** One-line summary for `aquila status`. */
export function triggerSummary(config: Config): string {
  if (config.guests === 'anyone') return 'anyone in the server (@mention)'
  const extra = triggerAllowFrom(config).length - 1
  return extra > 0 ? `you + ${extra} other${extra > 1 ? 's' : ''} (@mention)` : 'you only'
}
