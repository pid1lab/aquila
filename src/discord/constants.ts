/** Discord bitfields. Permissions exceed 2^53, so they are BigInt and serialise as strings. */

// ---- Application flags -----------------------------------------------------
// Only the *limited* intent flags can be set via PATCH /applications/@me.
// The unlimited variants require Discord's review process at 100+ servers.
export const GATEWAY_PRESENCE_LIMITED = 1 << 12
export const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15
export const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19 // 524288

// ---- Permissions -----------------------------------------------------------
export const CREATE_INSTANT_INVITE = 1n << 0n
export const ADMINISTRATOR = 1n << 3n
export const MANAGE_CHANNELS = 1n << 4n
export const ADD_REACTIONS = 1n << 6n
export const VIEW_CHANNEL = 1n << 10n
export const SEND_MESSAGES = 1n << 11n
export const ATTACH_FILES = 1n << 15n
export const READ_MESSAGE_HISTORY = 1n << 16n
export const MANAGE_ROLES = 1n << 28n
export const SEND_MESSAGES_IN_THREADS = 1n << 38n

/**
 * What an agent bot needs in its own channel. Matches the set the official
 * discord channel plugin asks for, so behaviour is identical once wired up.
 *
 * 274878008384
 */
export const AGENT_PERMISSIONS =
  VIEW_CHANNEL |
  SEND_MESSAGES |
  SEND_MESSAGES_IN_THREADS |
  READ_MESSAGE_HISTORY |
  ATTACH_FILES |
  ADD_REACTIONS

/**
 * The first bot installed also provisions: it creates every agent's channel and
 * mints the join invite. Needs MANAGE_CHANNELS to create them and MANAGE_ROLES
 * to set permission overwrites — Discord refuses overwrites from a bot that
 * lacks MANAGE_ROLES, and refuses to grant any permission the bot itself
 * doesn't hold.
 *
 * 275146443857
 */
export const PROVISIONER_PERMISSIONS =
  AGENT_PERMISSIONS | MANAGE_CHANNELS | MANAGE_ROLES | CREATE_INSTANT_INVITE

// ---- Channel types ---------------------------------------------------------
export const CHANNEL_TYPE_TEXT = 0

// ---- Permission overwrite targets -----------------------------------------
export const OVERWRITE_ROLE = 0
export const OVERWRITE_MEMBER = 1
