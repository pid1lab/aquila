/**
 * Looking people up, so nothing in Aquila's interface is a bare snowflake.
 *
 * Two endpoints, with quite different requirements:
 *
 *   GET /users/{id}                  resolves an id we already hold. No intent,
 *                                    no shared server needed.
 *   GET /guilds/{id}/members/search  resolves a name to an id. Works on an
 *                                    ordinary bot token — unlike
 *                                    GET /guilds/{id}/members, which is 403
 *                                    "Missing Access" without the privileged
 *                                    GUILD_MEMBERS intent.
 *
 * That asymmetry is why search is prefix-query only: there is no way to
 * enumerate a server's members without the intent, and `query` must be at least
 * one character. Good enough — you always know some of the name you're after.
 */

import type { APIGuildMember, APIUser } from 'discord-api-types/v10'
import { DiscordError, rest } from './rest.ts'

export interface Person {
  id: string
  /** The @handle. Unique, lowercase, and what someone types to find themselves. */
  username: string
  /** Discord's newer display name, when set. */
  globalName?: string
  /** Per-server nickname, when set — usually how they appear in the channel. */
  nick?: string
  bot: boolean
}

function fromUser(user: APIUser, nick?: string | null): Person {
  return {
    id: user.id,
    username: user.username,
    globalName: user.global_name ?? undefined,
    nick: nick ?? undefined,
    bot: user.bot ?? false,
  }
}

/**
 * How a person reads in output: the name you would recognise in the channel,
 * with the handle alongside when it differs, since that's what disambiguates.
 */
export function label(person: Person): string {
  const shown = person.nick ?? person.globalName
  return shown && shown !== person.username ? `${shown} (${person.username})` : person.username
}

/** Snowflakes are 17–20 digits; anything else the user typed is a name. */
export function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value)
}

/** Resolve an id we already hold. Undefined if the account is gone. */
export async function fetchUser(token: string, id: string): Promise<Person | undefined> {
  try {
    return fromUser(await rest<APIUser>(token, 'GET', `/users/${id}`))
  } catch (err) {
    if (err instanceof DiscordError && (err.status === 404 || err.status === 403)) return undefined
    throw err
  }
}

/** Prefix search over the server's members. Matches username, display name and nickname. */
export async function searchMembers(
  token: string,
  guildId: string,
  query: string,
  limit = 10,
): Promise<Person[]> {
  const members = await rest<APIGuildMember[]>(
    token,
    'GET',
    `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=${limit}`,
  )
  return members.filter(m => m.user).map(m => fromUser(m.user!, m.nick))
}

/**
 * Turn what the user typed into one person.
 *
 * An exact hit on a handle or display name wins outright — otherwise typing a
 * common name would be ambiguous with everyone who merely starts with it.
 */
export async function resolvePerson(
  token: string,
  guildId: string,
  input: string,
): Promise<{ person: Person } | { candidates: Person[] }> {
  if (isSnowflake(input)) {
    const person = await fetchUser(token, input)
    return person ? { person } : { candidates: [] }
  }

  const matches = await searchMembers(token, guildId, input)
  if (matches.length === 1) return { person: matches[0]! }

  const needle = input.toLowerCase().replace(/^@/, '')
  const exact = matches.filter(
    m =>
      m.username.toLowerCase() === needle ||
      m.globalName?.toLowerCase() === needle ||
      m.nick?.toLowerCase() === needle,
  )
  if (exact.length === 1) return { person: exact[0]! }

  return { candidates: matches }
}
