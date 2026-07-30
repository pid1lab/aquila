#!/usr/bin/env bun
/**
 * aquila — Discord channels for your Claude Code agents.
 *
 * Commands are stubs beyond `status`; the provisioning primitives they will
 * call already exist and are tested by spike/provision.ts.
 */

import { loadConfig } from './config.ts'
import { inviteUrl } from './discord/provision.ts'

const USAGE = `
aquila — Discord channels for your Claude Code agents

  aquila init <name...>        provision bots and channels for each agent
  aquila add <name> <path>     add one agent to an existing server
  aquila up [name]             launch agent sessions
  aquila down [name]           stop agent sessions
  aquila status                show agents, channels, and session state

Discord requires you to create each bot by hand in the Developer Portal
(https://discord.com/developers/applications) — there is no API for it.
Aquila does every other step.
`

async function status(): Promise<number> {
  const config = await loadConfig()

  if (!config.agents.length) {
    console.log('\nNo agents configured. Run `aquila init <name...>` to get started.\n')
    return 0
  }

  console.log(`\nserver:  ${config.guildId ?? '(none)'}`)
  console.log(`owner:   ${config.ownerId ?? '(not captured — join the server)'}\n`)

  for (const agent of config.agents) {
    const channel = agent.channelId ? `#${agent.name}` : '(no channel)'
    console.log(`  ${agent.name.padEnd(14)} ${channel.padEnd(16)} ${agent.path}`)
    if (!agent.channelId) {
      console.log(`  ${''.padEnd(14)} install: ${inviteUrl(agent.applicationId, config.guildId)}`)
    }
  }
  console.log()
  return 0
}

const command = process.argv[2]

switch (command) {
  case 'status':
    process.exit(await status())
  // eslint-disable-next-line no-fallthrough
  case 'init':
  case 'add':
  case 'up':
  case 'down':
    console.error(`\`aquila ${command}\` is not implemented yet.`)
    console.error('Provisioning primitives are ready — see src/discord/provision.ts.')
    process.exit(1)
  default:
    console.log(USAGE)
    process.exit(command ? 1 : 0)
}
