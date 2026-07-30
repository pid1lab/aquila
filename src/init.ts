/**
 * `aquila init` — from N pasted tokens to N running-ready agents.
 *
 * The shape of this flow is dictated by two Discord constraints:
 *
 *   1. We cannot create applications, so the user visits the portal N times.
 *   2. We cannot create the server (POST /guilds is closed to bots since
 *      2025-07-15), so the user makes it and we discover it.
 *
 * Everything between and after those is automatic. In particular nobody ever
 * copies a snowflake: the guild id comes from the first bot's own guild list,
 * and the user's id comes from that guild's owner_id.
 */

import { spawn } from 'node:child_process'
import {
  createAgentChannel,
  enableMessageContentIntent,
  getOwnerId,
  inviteUrl,
  listGuilds,
  renameBot,
  waitForGuild,
} from './discord/provision.ts'
import { AGENT_PERMISSIONS, PROVISIONER_PERMISSIONS } from './discord/constants.ts'
import {
  loadConfig,
  saveConfig,
  stateDirFor,
  writeAgentAccess,
  writeAgentToken,
  type Agent,
} from './config.ts'
import { collectViaTerminal, collectViaWeb } from './tokens.ts'

export interface InitOptions {
  web?: boolean
  port?: number
  /** Skip `claude plugin install`. */
  noPlugin?: boolean
}

/** `backend` or `backend=~/src/api` */
export function parseAgentSpec(spec: string, cwd: string): { name: string; path: string } {
  const eq = spec.indexOf('=')
  if (eq === -1) return { name: normaliseName(spec), path: cwd }
  return {
    name: normaliseName(spec.slice(0, eq)),
    path: expandHome(spec.slice(eq + 1)),
  }
}

/** Discord lowercases channel names and turns spaces into hyphens; do it up front. */
function normaliseName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? '~') : p
}

const step = (msg: string) => console.log(`  ${msg}`)
const done = (msg: string) => console.log(`  ✓ ${msg}`)

export async function runInit(specs: string[], options: InitOptions = {}): Promise<number> {
  const cwd = process.cwd()
  const parsed = specs.map(s => parseAgentSpec(s, cwd))

  const empty = parsed.find(p => !p.name)
  if (empty) {
    console.error(`Invalid agent name in "${specs[parsed.indexOf(empty)]}"`)
    return 1
  }

  const names = parsed.map(p => p.name)
  const duplicate = names.find((n, i) => names.indexOf(n) !== i)
  if (duplicate) {
    console.error(`Duplicate agent name: ${duplicate}`)
    return 1
  }

  const config = await loadConfig()
  const clash = parsed.find(p => config.agents.some(a => a.name === p.name))
  if (clash) {
    console.error(`Agent "${clash.name}" already exists. Use \`aquila add\` for new ones.`)
    return 1
  }

  console.log(`\nAquila — provisioning ${parsed.length} agent(s)\n`)

  // 1. Tokens. The only manual part, batched into one uninterrupted stretch.
  const tokens = options.web
    ? await collectViaWeb(names, options.port)
    : await collectViaTerminal(names)

  // 2. Per-bot setup that needs no server: intent flag and identity.
  console.log()
  for (const t of tokens) {
    await enableMessageContentIntent(t.token)
    await renameBot(t.token, t.agent)
    done(`${t.agent}: message content intent on, bot renamed`)
  }

  // 3. The server. The first bot provisions, so it needs MANAGE_CHANNELS and
  //    MANAGE_ROLES; it also installs before we know the guild id, so the user
  //    picks from the dropdown this once.
  const provisioner = tokens[0]
  if (!provisioner) {
    console.error('No tokens collected.')
    return 1
  }

  let guildId = config.guildId
  if (!guildId) {
    const already = await listGuilds(provisioner.token)
    const existing = already[0]
    if (existing) {
      guildId = existing.id
      done(`found server "${existing.name}"`)
    } else {
      console.log(`\n  Create a Discord server if you don't have one (+ → Create My Own),`)
      console.log(`  then install the first bot into it:\n`)
      console.log(`    ${inviteUrl(provisioner.applicationId, undefined, PROVISIONER_PERMISSIONS)}\n`)
      step('waiting for the install...')
      const guild = await waitForGuild(provisioner.token)
      guildId = guild.id
      done(`joined "${guild.name}"`)
    }
  }

  // 4. Who you are — no pairing code, no Developer Mode.
  const ownerId = config.ownerId ?? (await getOwnerId(provisioner.token, guildId))
  done(`owner ${ownerId}`)

  // 5. Remaining bots: one click each, server pre-selected.
  for (const t of tokens.slice(1)) {
    const joined = await listGuilds(t.token)
    if (joined.some(g => g.id === guildId)) {
      done(`${t.agent}: already in the server`)
      continue
    }
    console.log(`\n  Install ${t.agent}:\n`)
    console.log(`    ${inviteUrl(t.applicationId, guildId, AGENT_PERMISSIONS)}\n`)
    step('waiting...')
    await waitForGuild(t.token, { expectId: guildId })
    done(`${t.agent}: joined`)
  }

  // 6. Channels, each visible only to its own agent. Enforced by Discord, not
  //    by our routing — the reason this design uses one bot per agent.
  console.log()
  const agents: Agent[] = []

  // Persist after each agent. A failure partway then leaves consistent state —
  // the agents already provisioned are in config and usable, rather than being
  // orphaned channels and state dirs that nothing knows about.
  const persist = () => saveConfig({ guildId, ownerId, agents: [...config.agents, ...agents] })

  for (const [index, t] of tokens.entries()) {
    const spec = parsed[index]
    if (!spec) continue

    try {
      const channel = await createAgentChannel(provisioner.token, guildId, t.agent, t.botUserId)
      const stateDir = stateDirFor(t.agent)
      await writeAgentToken(stateDir, t.token)
      await writeAgentAccess(stateDir, ownerId, channel.id)

      agents.push({
        name: t.agent,
        path: spec.path,
        applicationId: t.applicationId,
        botUserId: t.botUserId,
        channelId: channel.id,
        stateDir,
      })
      await persist()
      done(`#${channel.name} → ${spec.path}`)
    } catch (err) {
      await persist()
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`\n  ✗ ${t.agent}: ${msg}`)
      console.error(`  ${agents.length} of ${tokens.length} agent(s) provisioned and saved.`)
      return 1
    }
  }

  // 7. The channel plugin each session loads. Non-interactive, so we do it.
  if (!options.noPlugin) {
    const ok = await installPlugin()
    if (ok) done('discord channel plugin installed')
    else step('! could not install the plugin — run `claude plugin install discord@claude-plugins-official`')
  }

  await persist()
  console.log(`\n  ${agents.length} agent(s) ready. Start them with:\n\n    aquila up\n`)
  return 0
}

function installPlugin(): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('claude', ['plugin', 'install', 'discord@claude-plugins-official'], {
      stdio: 'ignore',
    })
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}
