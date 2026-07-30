#!/usr/bin/env bun
/**
 * aquila — Discord channels for your Claude Code agents.
 */

import { loadConfig } from './config.ts'
import { inviteUrl } from './discord/provision.ts'
import { runInit } from './init.ts'

const USAGE = `
aquila — Discord channels for your Claude Code agents

  aquila init <agent...>       provision bots and channels for each agent
  aquila add <agent> <path>    add one agent to an existing server
  aquila up [agent]            launch agent sessions
  aquila down [agent]          stop agent sessions
  aquila status                show agents, channels, and session state

An agent is a name, optionally with a working directory:

  aquila init backend frontend
  aquila init backend=~/src/api frontend=~/src/web

Options for init:
  --web            paste tokens in a browser form instead of the terminal
  --port <n>       port for --web (default 7777)
  --no-plugin      skip installing the discord channel plugin

Discord requires you to create each bot by hand in the Developer Portal
(https://discord.com/developers/applications), and to create the server
yourself — POST /guilds has been closed to bots since 2025-07-15. Aquila
does every other step.
`

async function status(): Promise<number> {
  const config = await loadConfig()

  if (!config.agents.length) {
    console.log('\nNo agents configured. Run `aquila init <agent...>` to get started.\n')
    return 0
  }

  console.log(`\nserver:  ${config.guildId ?? '(none)'}`)
  console.log(`owner:   ${config.ownerId ?? '(not captured)'}\n`)

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

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

const argv = process.argv.slice(2)
const command = argv[0]
const rest = argv.slice(1)
const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--port')

switch (command) {
  case 'status':
    process.exit(await status())
    break

  case 'init': {
    if (!positional.length) {
      console.error('usage: aquila init <agent...>  (e.g. `aquila init backend frontend`)')
      process.exit(1)
    }
    const port = flagValue(rest, '--port')
    process.exit(
      await runInit(positional, {
        web: rest.includes('--web'),
        port: port ? Number(port) : undefined,
        noPlugin: rest.includes('--no-plugin'),
      }),
    )
    break
  }

  case 'add':
  case 'up':
  case 'down':
    console.error(`\`aquila ${command}\` is not implemented yet.`)
    process.exit(1)
    break

  default:
    console.log(USAGE)
    process.exit(command ? 1 : 0)
}
