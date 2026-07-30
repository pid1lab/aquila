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
  /** Extra flags for the claude invocation, e.g. --model. */
  claudeArgs?: string[]
}

export interface Config {
  /** The shared server all agents live in. */
  guildId?: string
  /** The human's snowflake, captured on join. Seeds each agent's allowlist. */
  ownerId?: string
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
