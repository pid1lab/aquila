/**
 * Permission and flag bitfields, taken from `discord-api-types` rather than
 * hand-computed.
 *
 * These were originally literal bit shifts (`1n << 38n` and friends). That works
 * until someone transposes a digit, and a wrong permission bit fails in the
 * worst way available: the API accepts it, the channel is created, and the bot
 * silently can't do something. Deriving them from the maintained typings removes
 * that class of mistake entirely.
 */

import { ApplicationFlags, ChannelType, OverwriteType, PermissionFlagsBits } from 'discord-api-types/v10'

// ---- Application flags -----------------------------------------------------
// Only the *limited* intent flags can be set via PATCH /applications/@me.
// The unlimited variants require Discord's review process at 100+ servers.
export const GATEWAY_MESSAGE_CONTENT_LIMITED = ApplicationFlags.GatewayMessageContentLimited

// ---- Permissions -----------------------------------------------------------
export const VIEW_CHANNEL = PermissionFlagsBits.ViewChannel

/**
 * What an agent bot needs in its own channel. Matches the set the official
 * discord channel plugin asks for, so behaviour is identical once wired up.
 *
 * 274878008384
 */
export const AGENT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.AddReactions

/**
 * The first bot installed also provisions: it creates every agent's channel and
 * mints the join invite. Needs ManageChannels to create them and ManageRoles to
 * set permission overwrites — Discord refuses overwrites from a bot that lacks
 * ManageRoles, and refuses to grant any permission the bot itself doesn't hold.
 *
 * 275146443857
 */
export const PROVISIONER_PERMISSIONS =
  AGENT_PERMISSIONS |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.CreateInstantInvite

// ---- Channel and overwrite kinds -------------------------------------------
export const CHANNEL_TYPE_TEXT = ChannelType.GuildText
export const OVERWRITE_ROLE = OverwriteType.Role
export const OVERWRITE_MEMBER = OverwriteType.Member
