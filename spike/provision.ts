#!/usr/bin/env bun
/**
 * Provisioning spike — validates the API chain Aquila's UX depends on.
 *
 *   bun spike/provision.ts <bot-token>
 *   bun spike/provision.ts <bot-token> --cleanup   # also delete the test guild
 *
 * Use a THROWAWAY app. This creates a real server and renames the bot.
 *
 * Each step reports independently and the run continues past failures — the
 * point is to learn which links hold, not to stop at the first surprise. The
 * step that actually matters is RENAME: it's the one Discord's docs don't
 * confirm works with a bot token.
 */

import {
  createAgentChannel,
  createInvite,
  deleteChannel,
  enableMessageContentIntent,
  getApplication,
  getBotUser,
  getOwnerId,
  inviteUrl,
  listGuilds,
  renameBot,
  waitForGuild,
} from '../src/discord/provision.ts'
import {
  AGENT_PERMISSIONS,
  GATEWAY_MESSAGE_CONTENT_LIMITED,
  PROVISIONER_PERMISSIONS,
} from '../src/discord/constants.ts'

const token = process.argv[2]
const cleanup = process.argv.includes('--cleanup')

if (!token || token.startsWith('--')) {
  console.error('usage: bun spike/provision.ts <bot-token> [--cleanup]')
  process.exit(1)
}

const results: { step: string; ok: boolean; note: string }[] = []

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  process.stdout.write(`  ${name} ... `)
  try {
    const value = await fn()
    console.log('ok')
    results.push({ step: name, ok: true, note: '' })
    return value
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`FAILED — ${msg}`)
    results.push({ step: name, ok: false, note: msg })
    return undefined
  }
}

console.log('\nAquila provisioning spike\n')

// 1. Token validity + starting state.
const app = await step('identify application', () => getApplication(token))
if (!app) {
  console.error('\nToken rejected. Nothing else can be tested.')
  process.exit(1)
}
console.log(`      app "${app.name}" (${app.id}), flags=${app.flags}`)

const botUser = await step('read bot user', () => getBotUser(token))
if (botUser) console.log(`      bot @${botUser.username} (${botUser.id})`)

// 2. Message Content intent — verified settable per Discord's docs (limited flags only).
const patched = await step('enable message content intent', () =>
  enableMessageContentIntent(token),
)
if (patched) {
  const on = (patched.flags & GATEWAY_MESSAGE_CONTENT_LIMITED) !== 0
  console.log(`      flags=${patched.flags}, intent ${on ? 'ON' : 'still OFF (!)'} `)
  if (!on) results[results.length - 1] = {
    step: 'enable message content intent',
    ok: false,
    note: 'PATCH accepted but flag did not stick',
  }
}

// 3. THE UNCERTAIN ONE. Docs describe PATCH /users/@me generically without
//    confirming bot-token support. Discord also rate-limits this to ~2/hour.
const renamed = await step('rename bot user', () =>
  renameBot(token, `aquila-spike-${Math.floor(Math.random() * 9999)}`),
)
if (renamed) console.log(`      renamed to @${renamed.username}`)

// 4. Find the server. Aquila cannot create it — Discord restricted POST /guilds
//    for applications on 2025-07-15. The human makes it; we discover the id.
const existing = await step('list guilds', () => listGuilds(token))
if (existing && !existing.length) {
  console.log(`\n  Bot is in no servers. Create one in Discord (+ → Create My Own),`)
  console.log(`  then install this bot into it:\n`)
  console.log(`    ${inviteUrl(app.id, undefined, PROVISIONER_PERMISSIONS)}\n`)
  console.log(`  Waiting up to 5 minutes...`)
}

const guild = await step('discover guild', () => waitForGuild(token))
if (guild) console.log(`      guild "${guild.name}" (${guild.id})`)

// 5. Owner snowflake — no gateway, no pairing code.
let ownerId: string | undefined
if (guild) {
  ownerId = await step('read owner id', () => getOwnerId(token, guild.id))
  if (ownerId) console.log(`      owner ${ownerId} — seeds each agent's allowlist`)
}

// 6. Scoped channel — the isolation that justifies one-bot-per-agent.
//    Requires MANAGE_CHANNELS + MANAGE_ROLES, hence PROVISIONER_PERMISSIONS.
let channelId: string | undefined
if (guild && botUser) {
  const channel = await step('create scoped channel', () =>
    createAgentChannel(token, guild.id, 'aquila-spike', botUser.id),
  )
  channelId = channel?.id
  if (channel) console.log(`      #${channel.name} (${channel.id}), @everyone denied VIEW_CHANNEL`)
}

// 7. Invite for teammates.
if (channelId) {
  const url = await step('create invite', () => createInvite(token, channelId))
  if (url) console.log(`      join: ${url}`)
}

// 8. Pure string construction — no API call, but worth eyeballing.
console.log(`\n  one-click install url (agent):\n    ${inviteUrl(app.id, guild?.id)}`)
console.log(
  `\n  one-click install url (provisioner):\n    ${inviteUrl(app.id, guild?.id, PROVISIONER_PERMISSIONS)}`,
)
console.log(`\n  agent permissions:       ${AGENT_PERMISSIONS}`)
console.log(`  provisioner permissions: ${PROVISIONER_PERMISSIONS}`)

// 9. Optional teardown. Only the channel — the server belongs to the user now.
if (cleanup && channelId) {
  await step('delete channel', () => deleteChannel(token, channelId))
} else if (channelId) {
  console.log(`\n  test channel left in place — rerun with --cleanup to delete it`)
}

// Summary.
const failed = results.filter(r => !r.ok)
console.log(`\n${'─'.repeat(60)}`)
console.log(`${results.length - failed.length}/${results.length} steps passed`)
for (const f of failed) console.log(`  ✗ ${f.step}: ${f.note}`)
if (!failed.length) console.log('\nWhole chain holds. The CLI can assume all of it.\n')
else console.log('\nSee notes above — failed steps become manual portal work.\n')

process.exit(failed.length ? 1 : 0)
