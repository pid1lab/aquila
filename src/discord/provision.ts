/**
 * The provisioning chain: everything Aquila can do for you once you paste a token.
 *
 * What is NOT here, and cannot be: creating the Discord application itself.
 * There is no public endpoint for it. The Developer Portal drives private v9
 * routes with a *user* token, and automating that means driving a user account,
 * which is self-botting under Discord's ToS. Aquila does not do it. The ~40s
 * per agent spent in the portal is irreducible and documented as such.
 */

import { rest, imageDataUri } from './rest.ts'
import {
  AGENT_PERMISSIONS,
  CHANNEL_TYPE_TEXT,
  GATEWAY_MESSAGE_CONTENT_LIMITED,
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  VIEW_CHANNEL,
} from './constants.ts'

export interface Application {
  id: string
  name: string
  flags: number
  bot?: { id: string; username: string }
}

export interface User {
  id: string
  username: string
}

export interface Guild {
  id: string
  name: string
  owner_id?: string
}

export interface Channel {
  id: string
  name: string
  guild_id?: string
}

/** Identify the app behind a token. First call for any token — validates it too. */
export function getApplication(token: string): Promise<Application> {
  return rest<Application>(token, 'GET', '/oauth2/applications/@me')
}

/** The bot's own user account. `id` here is what permission overwrites target. */
export function getBotUser(token: string): Promise<User> {
  return rest<User>(token, 'GET', '/users/@me')
}

/**
 * Enable the Message Content intent.
 *
 * Without this the bot receives messages with empty content — the single most
 * common setup failure with the official plugin, and the reason its README
 * puts a warning next to the checkbox.
 *
 * We OR onto existing flags rather than overwrite so we don't clear intents the
 * user enabled by hand. Discord documents only the *limited* flags as settable;
 * if it rejects a payload carrying read-only bits we retry with just our flag.
 */
export async function enableMessageContentIntent(token: string): Promise<Application> {
  const app = await getApplication(token)
  if (app.flags & GATEWAY_MESSAGE_CONTENT_LIMITED) return app

  const merged = app.flags | GATEWAY_MESSAGE_CONTENT_LIMITED
  try {
    return await rest<Application>(token, 'PATCH', '/applications/@me', { flags: merged })
  } catch {
    return await rest<Application>(token, 'PATCH', '/applications/@me', {
      flags: GATEWAY_MESSAGE_CONTENT_LIMITED,
    })
  }
}

/**
 * Rename the bot user and optionally set its avatar.
 *
 * UNVERIFIED against a live bot token — Discord documents PATCH /users/@me
 * generically without confirming bot compatibility. If this fails, per-agent
 * naming falls back to a manual field in the portal. The spike exists to answer
 * this before the CLI's UX is designed around it.
 *
 * Note Discord rate-limits username changes aggressively (2 per hour per bot).
 */
export async function renameBot(
  token: string,
  username: string,
  avatarPath?: string,
): Promise<User> {
  const body: Record<string, unknown> = { username }
  if (avatarPath) body.avatar = await imageDataUri(avatarPath)
  return rest<User>(token, 'PATCH', '/users/@me', body)
}

/** Guilds this bot is in. */
export function listGuilds(token: string): Promise<Guild[]> {
  return rest<Guild[]>(token, 'GET', '/users/@me/guilds')
}

/** Full guild object. `owner_id` is the human who created the server. */
export function getGuild(token: string, guildId: string): Promise<Guild> {
  return rest<Guild>(token, 'GET', `/guilds/${guildId}`)
}

/**
 * Wait for the user to install this bot into a server, then report which one.
 *
 * Aquila cannot create the server: Discord restricted POST /guilds for
 * applications on 2025-07-15 ("Bots cannot use this endpoint") and moved
 * bot-owned guilds to real users. So the human makes the server — three clicks
 * in the Discord client — and we *discover* its id from the bot's own guild
 * list rather than asking anyone to copy a snowflake.
 *
 * That detail matters: it's what keeps Developer Mode and right-click-Copy-ID
 * out of the setup flow entirely.
 */
export async function waitForGuild(
  token: string,
  { timeoutMs = 300_000, intervalMs = 3_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Guild> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const guilds = await listGuilds(token)
    const first = guilds[0]
    if (first) return first
    if (Date.now() >= deadline) {
      throw new Error(`Bot was not added to any server within ${Math.round(timeoutMs / 1000)}s.`)
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/**
 * The human's snowflake, for seeding each agent's allowlist.
 *
 * They created the server, so they own it — no gateway connection, no member
 * polling, and no pairing-code exchange needed to learn who they are.
 */
export async function getOwnerId(token: string, guildId: string): Promise<string> {
  const guild = await getGuild(token, guildId)
  if (!guild.owner_id) throw new Error(`Guild ${guildId} returned no owner_id`)
  return guild.owner_id
}

export function deleteChannel(token: string, channelId: string): Promise<void> {
  return rest<void>(token, 'DELETE', `/channels/${channelId}`)
}

/**
 * Create an agent's channel, visible only to that agent's bot and to the human.
 *
 * This isolation is Discord-enforced rather than enforced by our own routing —
 * the payoff for the one-bot-per-agent design. A bug in Aquila cannot leak
 * #backend traffic to the frontend agent, because Discord will not deliver it.
 *
 * @everyone's role id is always the guild id.
 */
export function createAgentChannel(
  token: string,
  guildId: string,
  name: string,
  agentBotUserId: string,
  humanUserIds: string[] = [],
): Promise<Channel> {
  return rest<Channel>(token, 'POST', `/guilds/${guildId}/channels`, {
    name,
    type: CHANNEL_TYPE_TEXT,
    permission_overwrites: [
      { id: guildId, type: OVERWRITE_ROLE, deny: VIEW_CHANNEL.toString() },
      { id: agentBotUserId, type: OVERWRITE_MEMBER, allow: AGENT_PERMISSIONS.toString() },
      ...humanUserIds.map(id => ({
        id,
        type: OVERWRITE_MEMBER,
        allow: (VIEW_CHANNEL | AGENT_PERMISSIONS).toString(),
      })),
    ],
  })
}

/** A join link for the human. Never expires, unlimited uses. */
export async function createInvite(token: string, channelId: string): Promise<string> {
  const invite = await rest<{ code: string }>(token, 'POST', `/channels/${channelId}/invites`, {
    max_age: 0,
    max_uses: 0,
    unique: true,
  })
  return `https://discord.gg/${invite.code}`
}

/**
 * The bot's install link, with the target server pre-selected.
 *
 * `guild_id` pre-fills the dropdown and `disable_guild_select` locks it, so the
 * user sees one Authorize button rather than a server picker and a wall of
 * permission checkboxes. This replaces the OAuth2 URL Generator entirely.
 *
 * The first bot is installed before we know the guild id, so it gets no
 * `guild_id` and the user picks from the dropdown once. Every bot after that is
 * a single click. Pass PROVISIONER_PERMISSIONS for whichever bot creates the
 * channels; AGENT_PERMISSIONS for the rest.
 */
export function inviteUrl(
  applicationId: string,
  guildId?: string,
  permissions: bigint = AGENT_PERMISSIONS,
): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: 'bot',
    permissions: permissions.toString(),
  })
  if (guildId) {
    params.set('guild_id', guildId)
    params.set('disable_guild_select', 'true')
  }
  return `https://discord.com/oauth2/authorize?${params}`
}
