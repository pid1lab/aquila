/**
 * Aquila's own state, kept separate from the per-agent Discord state dirs that
 * the channel plugin reads (`~/.claude/channels/discord/` by default, or
 * whatever DISCORD_STATE_DIR points at — one per agent).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export const AQUILA_DIR = process.env.AQUILA_HOME ?? join(homedir(), '.aquila')
export const CONFIG_FILE = join(AQUILA_DIR, 'config.json')

export interface Agent {
  /** Channel name and agent id. Lowercase, no spaces — Discord normalises anyway. */
  name: string
  /** Working directory the Claude Code session runs in. */
  path: string
  /** Discord application id for this agent's bot. */
  applicationId: string
  /** The bot's user id — what channel permission overwrites target. */
  botUserId: string
  /** Channel this agent owns. */
  channelId?: string
  /** Where this agent's plugin state lives; becomes DISCORD_STATE_DIR. */
  stateDir: string
  /** Process group leader from the last `aquila up`, if any. */
  pid?: number
  /**
   * The Claude Code conversation this agent drives, minted by Aquila on first
   * start and resumed on every restart. Repoint with `aquila bind`.
   */
  sessionId?: string
  /** Extra flags for the claude invocation, e.g. --model. */
  claudeArgs?: string[]
}

export interface Config {
  /** The shared server all agents live in. */
  guildId?: string
  /**
   * Which agent's bot holds MANAGE_CHANNELS/MANAGE_ROLES and can therefore
   * create channels for new agents. Normally the first one installed.
   */
  provisionerAgent?: string
  /** The human's snowflake, captured on join. Seeds each agent's allowlist. */
  ownerId?: string
  /**
   * Opt agents into every channel their bot can see, refreshed as commands run.
   * Unset means on. `aquila sync --off` turns it off and leaves the plugin's
   * strict default in place: channels are reachable only once opted in by hand.
   */
  autoChannels?: boolean
  /**
   * Who besides you can trigger an agent in a shared channel. Snowflakes, or
   * `'anyone'` for every server member. Absent means you alone.
   *
   * A mention is still required either way, and this never applies to an
   * agent's own private channel — that stays yours.
   */
  guests?: string[] | 'anyone'
  agents: Agent[]
}

const EMPTY: Config = { agents: [] }

export async function loadConfig(): Promise<Config> {
  try {
    return { ...EMPTY, ...JSON.parse(await readFile(CONFIG_FILE, 'utf8')) }
  } catch {
    return { ...EMPTY }
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(AQUILA_DIR, { recursive: true, mode: 0o700 })
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

/** Per-agent state dir, so each bot gets its own token and allowlist. */
export function stateDirFor(agentName: string): string {
  return join(AQUILA_DIR, 'agents', agentName)
}

/**
 * Any usable bot token, for calls that aren't about a particular agent —
 * listing channels, looking up members. The provisioner first, since it is the
 * one guaranteed to still be in the server.
 */
export async function anyToken(config: Config): Promise<string | undefined> {
  const order = [
    ...config.agents.filter(a => a.name === config.provisionerAgent),
    ...config.agents.filter(a => a.name !== config.provisionerAgent),
  ]
  for (const agent of order) {
    const token = await readAgentToken(agent.stateDir)
    if (token) return token
  }
  return undefined
}

/** Read an agent's bot token back out of its state dir. */
export async function readAgentToken(stateDir: string): Promise<string | undefined> {
  try {
    const env = await readFile(join(stateDir, '.env'), 'utf8')
    return /^DISCORD_BOT_TOKEN=(.+)$/m.exec(env)?.[1]?.trim()
  } catch {
    return undefined
  }
}

/**
 * The channel plugin's own MCP tools.
 *
 * These need pre-approval or the agent asks permission *to speak on Discord* —
 * `reply` is how it answers at all, so without this every single message
 * triggers a DM with Allow/Deny buttons and the agent is effectively unusable.
 *
 * Named `mcp__<server>__<tool>`, where the server is `plugin:discord:discord`
 * with colons replaced by underscores.
 */
export const CHANNEL_TOOLS = [
  'mcp__plugin_discord_discord__reply',
  'mcp__plugin_discord_discord__react',
  'mcp__plugin_discord_discord__edit_message',
  'mcp__plugin_discord_discord__fetch_messages',
  'mcp__plugin_discord_discord__download_attachment',
]

/**
 * Pre-approve the channel tools in the agent's working directory.
 *
 * Written to `.claude/settings.local.json` rather than `settings.json`: the
 * local file is the conventional home for machine-specific settings and is
 * normally gitignored, so we don't commit Aquila's plumbing into someone's
 * repo. Existing entries are preserved — an agent's directory is usually a real
 * project whose settings are none of our business.
 */
export async function writeAgentSettings(workdir: string): Promise<void> {
  const dir = join(workdir, '.claude')
  const file = join(dir, 'settings.local.json')

  let settings: { permissions?: { allow?: string[] } } = {}
  try {
    settings = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    /* absent or unreadable — start fresh rather than fail provisioning */
  }

  const existing = settings.permissions?.allow ?? []
  const merged = [...new Set([...existing, ...CHANNEL_TOOLS])]
  settings.permissions = { ...settings.permissions, allow: merged }

  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n')
}

/**
 * Write an agent's bot token where the channel plugin expects it.
 * Mode 0600 — this is a credential.
 */
export async function writeAgentToken(stateDir: string, token: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFile(join(stateDir, '.env'), `DISCORD_BOT_TOKEN=${token}\n`, { mode: 0o600 })
}

/**
 * Seed an agent's access.json: locked to the owner, its own channel opted in,
 * no mention required since the channel is dedicated to this one agent.
 *
 * This is what removes the pairing dance — we already know the snowflakes.
 */
export async function writeAgentAccess(
  stateDir: string,
  ownerId: string,
  channelId: string,
): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const access = {
    dmPolicy: 'allowlist',
    allowFrom: [ownerId],
    groups: { [channelId]: { requireMention: false, allowFrom: [ownerId] } },
    ackReaction: '👀',
    replyToMode: 'first',
    textChunkLimit: 2000,
    chunkMode: 'newline',
  }
  await writeFile(join(stateDir, 'access.json'), JSON.stringify(access, null, 2) + '\n', {
    mode: 0o600,
  })
}
