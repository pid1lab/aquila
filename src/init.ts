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
 * You name each agent; the application can be called anything. The bot is made
 * to *display* as its agent name via a per-guild nickname, which is scoped to
 * your server and generously rate-limited — unlike renameBot, which changes the
 * bot's global username everywhere and is capped at roughly 2/hour.
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
  setGuildNickname,
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
import { collectViaTerminal, collectViaWeb, type CollectedToken } from './tokens.ts'

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

/** `backend` or `backend=~/src/api` */
export function parseAgentSpec(spec: string, cwd: string): { name: string; path: string } {
  const eq = spec.indexOf('=')
  if (eq === -1) return { name: normaliseName(spec), path: cwd }
  return { name: normaliseName(spec.slice(0, eq)), path: expandHome(spec.slice(eq + 1)) }
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

/**
 * Make the bot display as its agent name in this server.
 *
 * A nickname rather than a rename: scoped to the guild, generous rate limit,
 * and it leaves the user's application identity alone. Cosmetic, so a failure
 * is reported and never fatal.
 */
async function nameInGuild(token: string, guildId: string, agent: string): Promise<void> {
  try {
    await setGuildNickname(token, guildId, agent)
    done(`${agent}: shows as "${agent}" in the server`)
  } catch {
    step(`! ${agent}: could not set nickname (needs CHANGE_NICKNAME)`)
  }
}

/** Flip the intent flag, and optionally rename. Shared by init and add. */
async function prepareBot(t: CollectedToken, rename: boolean): Promise<void> {
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

function collect(agents: string[], options: InitOptions): Promise<CollectedToken[]> {
  return options.web ? collectViaWeb(agents, options.port) : collectViaTerminal(agents)
}

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
  const tokens = await collect(names, options)
  if (!tokens.length) {
    console.error('No tokens collected.')
    return 1
  }
  const pathFor = (agent: string) =>
    parsed.find(p => p.name === agent)?.path ?? cwd

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

  // 6. Display names. Only possible once each bot is in the guild.
  for (const t of tokens) await nameInGuild(t.token, guildId, t.agent)

  // 7. Channels, each visible only to its own agent. Enforced by Discord, not
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
      await writeAgentSettings(pathFor(t.agent))

      agents.push({
        name: t.agent,
        path: pathFor(t.agent),
        applicationId: t.applicationId,
        botUserId: t.botUserId,
        channelId: channel.id,
        stateDir,
      })
      await persist()
      done(`#${channel.name}${reused ? ' (existing)' : ''} → ${pathFor(t.agent)}`)
    } catch (err) {
      await persist()
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`\n  ✗ ${t.agent}: ${msg}`)
      console.error(`  ${agents.length} of ${tokens.length} agent(s) provisioned and saved.`)
      return 1
    }
  }

  // 8. The channel plugin each session loads. Non-interactive, so we do it.
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
export async function runAdd(specs: string[], options: InitOptions = {}): Promise<number> {
  const config = await loadConfig()

  if (!config.guildId || !config.ownerId) {
    console.error('\nNo server configured yet. Run `aquila init` first.\n')
    return 1
  }
  if (!config.agents.length) {
    console.error('\nNo existing agents to create the channel with. Run `aquila init` first.\n')
    return 1
  }

  // Accept `add reviewer ~/src/x` as well as `add reviewer=~/src/x`.
  const joined =
    specs.length === 2 && !specs[0]!.includes('=') ? `${specs[0]}=${specs[1]}` : specs[0] ?? ''
  const spec = parseAgentSpec(joined, process.cwd())
  if (!spec.name) {
    console.error('usage: aquila add <agent> [path]')
    return 1
  }
  if (config.agents.some(a => a.name === spec.name)) {
    console.error(`Agent "${spec.name}" already exists.`)
    return 1
  }

  console.log(`\nAquila — adding agent "${spec.name}"\n`)

  const collected = await collect([spec.name], options)
  const t = collected[0]
  if (!t) {
    console.error('No token collected.')
    return 1
  }

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

  await nameInGuild(t.token, config.guildId, t.agent)

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
  await writeAgentSettings(spec.path)

  config.provisionerAgent = provisioner
  config.agents.push({
    name: t.agent,
    path: spec.path,
    applicationId: t.applicationId,
    botUserId: t.botUserId,
    channelId: channel.id,
    stateDir,
  })
  await saveConfig(config)

  done(`#${channel.name} → ${spec.path}`)
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
