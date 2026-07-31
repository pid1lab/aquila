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
 *
 * Agent names come from the applications themselves. The user already names each
 * app in the portal, so taking that as the source of truth means the bot's
 * display name, the agent name, and the channel name agree by construction — and
 * we never call renameBot, which Discord rate-limits to ~2/hour per bot.
 */

import { spawn } from 'node:child_process'
import {
  applyAgentOverwrites,
  createAgentChannel,
  enableMessageContentIntent,
  findChannelByName,
  getOwnerId,
  inviteUrl,
  listGuilds,
  renameBot,
  waitForGuild,
  type Channel,
} from './discord/provision.ts'
import { AGENT_PERMISSIONS, PROVISIONER_PERMISSIONS, VIEW_CHANNEL } from './discord/constants.ts'
import {
  loadConfig,
  readAgentToken,
  saveConfig,
  stateDirFor,
  writeAgentAccess,
  writeAgentSettings,
  writeAgentToken,
  type Agent,
  type Config,
} from './config.ts'
import {
  collectViaTerminal,
  collectViaWeb,
  promptLine,
  type CollectedToken,
} from './tokens.ts'

export interface InitOptions {
  web?: boolean
  port?: number
  /** Skip `claude plugin install`. */
  noPlugin?: boolean
  /** Rename each bot to its agent name. Off by default — Discord rate-limits it. */
  rename?: boolean
  /** Take over an existing channel that already has the agent's name. */
  adopt?: boolean
}

/** An agent we're about to provision: a validated token plus its resolved identity. */
interface Planned extends CollectedToken {
  agent: string
  path: string
}

/** Discord lowercases channel names and turns spaces into hyphens; do it up front. */
export function normaliseName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? '~') : p
}

/**
 * Turn an application name into an agent name, avoiding collisions.
 *
 * Two apps can share a name — nothing in Discord prevents it — and two agents
 * cannot, since the name is also the channel name and the state directory.
 */
function uniqueName(appName: string, taken: Set<string>): string {
  const base = normaliseName(appName) || 'agent'
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  taken.add(name)
  return name
}

const step = (msg: string) => console.log(`  ${msg}`)
const done = (msg: string) => console.log(`  ✓ ${msg}`)

/**
 * Create an agent's channel, coping with one that already has the name.
 *
 * Discord allows duplicate channel names, so creating blindly would leave the
 * user staring at two identical `#backend` channels with the agent bound to
 * whichever one we made last — and messages typed in the other silently ignored.
 *
 * Three cases:
 *   - no channel by that name  → create it
 *   - one that already grants this bot access → adopt it silently; this is a
 *     re-run of a partly-finished init, and doing nothing is correct
 *   - one belonging to something else → refuse, unless --adopt says to take it
 */
async function ensureAgentChannel(
  token: string,
  guildId: string,
  name: string,
  botUserId: string,
  adopt: boolean,
): Promise<{ channel: Channel; reused: boolean }> {
  const existing = await findChannelByName(token, guildId, name)
  if (!existing) {
    return { channel: await createAgentChannel(token, guildId, name, botUserId), reused: false }
  }

  const alreadyOurs = existing.permission_overwrites?.some(
    o => o.id === botUserId && (BigInt(o.allow) & VIEW_CHANNEL) !== 0n,
  )
  if (alreadyOurs) return { channel: existing, reused: true }

  if (!adopt) {
    throw new Error(
      `#${name} already exists in this server and isn't wired to this bot.\n` +
        `    Rename the application in the Developer Portal, delete that channel,\n` +
        `    or re-run with --adopt to take it over (this rewrites its permissions).`,
    )
  }

  await applyAgentOverwrites(token, existing.id, guildId, botUserId)
  return { channel: existing, reused: true }
}

/** Flip the intent flag, and optionally rename. Shared by init and add. */
async function prepareBot(t: Planned, rename: boolean): Promise<void> {
  // Load-bearing: without this the bot receives messages with empty content.
  await enableMessageContentIntent(t.token)

  if (!rename) {
    done(`${t.agent}: message content intent on`)
    return
  }
  try {
    await renameBot(t.token, t.agent)
    done(`${t.agent}: message content intent on, bot renamed`)
  } catch {
    done(`${t.agent}: message content intent on (rename skipped — rate limited?)`)
  }
}

async function collect(
  count: number | undefined,
  options: InitOptions,
): Promise<CollectedToken[] | string> {
  if (!options.web) return collectViaTerminal(count)
  if (count === undefined) {
    return 'With --web, pass a working directory per agent so the form knows how many fields to show.'
  }
  return collectViaWeb(count, options.port, t => normaliseName(t.appName))
}

/** Assign each collected token its agent name and working directory. */
async function plan(
  tokens: CollectedToken[],
  paths: string[],
  taken: Set<string>,
  interactive: boolean,
): Promise<Planned[]> {
  const planned: Planned[] = []
  for (const [i, t] of tokens.entries()) {
    const agent = uniqueName(t.appName, taken)
    const given = paths[i]
    const path = given
      ? expandHome(given)
      : interactive
        ? expandHome(await promptLine(`  path for ${agent}`, process.cwd()))
        : process.cwd()
    planned.push({ ...t, agent, path })
  }
  return planned
}

export async function runInit(paths: string[], options: InitOptions = {}): Promise<number> {
  const config = await loadConfig()

  console.log(`\nAquila — provisioning agents\n`)

  // 1. Tokens. The only manual part, batched into one uninterrupted stretch.
  const collected = await collect(paths.length || undefined, options)
  if (typeof collected === 'string') {
    console.error(`\n  ✗ ${collected}\n`)
    return 1
  }
  if (!collected.length) {
    console.error('No tokens collected.')
    return 1
  }

  // 2. Names from the apps, paths from args or prompts.
  const taken = new Set(config.agents.map(a => a.name))
  const tokens = await plan(collected, paths, taken, !options.web && paths.length === 0)

  console.log()
  for (const t of tokens) await prepareBot(t, !!options.rename)

  // 3. The server. The first bot provisions, so it needs MANAGE_CHANNELS and
  //    MANAGE_ROLES; it also installs before we know the guild id, so the user
  //    picks from the dropdown this once.
  const provisioner = tokens[0]!

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
  const persist = () =>
    saveConfig({
      guildId,
      ownerId,
      provisionerAgent: config.provisionerAgent ?? provisioner.agent,
      agents: [...config.agents, ...agents],
    })

  for (const t of tokens) {
    try {
      const { channel, reused } = await ensureAgentChannel(
        provisioner.token,
        guildId,
        t.agent,
        t.botUserId,
        !!options.adopt,
      )
      const stateDir = stateDirFor(t.agent)
      await writeAgentToken(stateDir, t.token)
      await writeAgentAccess(stateDir, ownerId, channel.id)
      // Without this the agent needs permission to use `reply` — i.e. to answer
      // at all — and every message becomes a DM approval.
      await writeAgentSettings(t.path)

      agents.push({
        name: t.agent,
        path: t.path,
        applicationId: t.applicationId,
        botUserId: t.botUserId,
        channelId: channel.id,
        stateDir,
      })
      await persist()
      done(`#${channel.name}${reused ? ' (existing)' : ''} → ${t.path}`)
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

/**
 * Create a channel using whichever existing bot can.
 *
 * Only the first bot installed carries MANAGE_CHANNELS/MANAGE_ROLES, so new
 * agents can't create their own channel — an established bot has to do it for
 * them. We remember which one worked; for configs written before that was
 * tracked, we try each agent in turn and record the winner.
 */
async function createChannelVia(
  config: Config,
  guildId: string,
  name: string,
  botUserId: string,
  adopt: boolean,
): Promise<{ channel: Channel; provisioner: string }> {
  const ordered = [
    ...config.agents.filter(a => a.name === config.provisionerAgent),
    ...config.agents.filter(a => a.name !== config.provisionerAgent),
  ]

  let lastError: unknown
  for (const candidate of ordered) {
    const token = await readAgentToken(candidate.stateDir)
    if (!token) continue
    try {
      const { channel } = await ensureAgentChannel(token, guildId, name, botUserId, adopt)
      return { channel, provisioner: candidate.name }
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `No existing bot could create #${name} — none of them hold MANAGE_CHANNELS. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/** `aquila add [path]` — one more agent in the server you already have. */
export async function runAdd(paths: string[], options: InitOptions = {}): Promise<number> {
  const config = await loadConfig()

  if (!config.guildId || !config.ownerId) {
    console.error('\nNo server configured yet. Run `aquila init` first.\n')
    return 1
  }
  if (!config.agents.length) {
    console.error('\nNo existing agents to create the channel with. Run `aquila init` first.\n')
    return 1
  }

  console.log(`\nAquila — adding an agent\n`)

  const collected = await collect(1, options)
  if (typeof collected === 'string') {
    console.error(`\n  ✗ ${collected}\n`)
    return 1
  }
  const first = collected[0]
  if (!first) {
    console.error('No token collected.')
    return 1
  }

  const taken = new Set(config.agents.map(a => a.name))
  const [t] = await plan([first], paths, taken, !options.web && paths.length === 0)
  if (!t) return 1

  console.log()
  await prepareBot(t, !!options.rename)

  // One click: the server is already known, so it's pre-selected and locked.
  const already = await listGuilds(t.token)
  if (already.some(g => g.id === config.guildId)) {
    done('already in the server')
  } else {
    console.log(`\n  Install ${t.agent}:\n`)
    console.log(`    ${inviteUrl(t.applicationId, config.guildId, AGENT_PERMISSIONS)}\n`)
    step('waiting...')
    await waitForGuild(t.token, { expectId: config.guildId })
    done('joined')
  }

  const { channel, provisioner } = await createChannelVia(
    config,
    config.guildId,
    t.agent,
    t.botUserId,
    !!options.adopt,
  )

  const stateDir = stateDirFor(t.agent)
  await writeAgentToken(stateDir, t.token)
  await writeAgentAccess(stateDir, config.ownerId, channel.id)
  await writeAgentSettings(t.path)

  config.provisionerAgent = provisioner
  config.agents.push({
    name: t.agent,
    path: t.path,
    applicationId: t.applicationId,
    botUserId: t.botUserId,
    channelId: channel.id,
    stateDir,
  })
  await saveConfig(config)

  done(`#${channel.name} → ${t.path}`)
  console.log(`\n  Start it with:\n\n    aquila up ${t.agent}\n`)
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
