#!/usr/bin/env bun
/**
 * aquila — Discord channels for your Claude Code agents.
 */

import { runAdd, runInit } from './init.ts'
import { runDown, runStatus, runUp } from './up.ts'

const USAGE = `
aquila — Discord channels for your Claude Code agents

  aquila init [path...]        provision bots and channels for each agent
  aquila add [path]            add one agent to the server you already have
  aquila up [agent...]         start agents (returns immediately)
                               --trust  accept Claude Code's folder-trust
                                        prompt for each agent's directory
  aquila down [agent...]       stop agents
  aquila status                show agents, channels, and session state

Agents are named after their Discord application, so name each app in the
portal what you want the agent called. Arguments are working directories:

  aquila init ~/src/api ~/src/web     two agents, in those directories
  aquila init                         prompts for a directory per agent

up/down with no names act on every agent.

Options for init and add:
  --web            paste tokens in a browser form instead of the terminal
  --port <n>       port for --web (default 7777)
  --rename         rename each bot to its agent name (Discord limits this
                   to ~2/hour per bot; off by default)
  --no-plugin      skip installing the discord channel plugin (init only)

Discord requires you to create each bot by hand in the Developer Portal
(https://discord.com/developers/applications), and to create the server
yourself — POST /guilds has been closed to bots since 2025-07-15. Aquila
does every other step.
`

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
    process.exit(await runStatus())
    break

  case 'up':
    process.exit(await runUp(positional, { trust: rest.includes('--trust') }))
    break

  case 'down':
    process.exit(await runDown(positional))
    break

  case 'init': {
    const port = flagValue(rest, '--port')
    process.exit(
      await runInit(positional, {
        web: rest.includes('--web'),
        port: port ? Number(port) : undefined,
        noPlugin: rest.includes('--no-plugin'),
        rename: rest.includes('--rename'),
      }),
    )
    break
  }

  case 'add': {
    const port = flagValue(rest, '--port')
    process.exit(
      await runAdd(positional, {
        web: rest.includes('--web'),
        port: port ? Number(port) : undefined,
        rename: rest.includes('--rename'),
      }),
    )
    break
  }

  default:
    console.log(USAGE)
    process.exit(command ? 1 : 0)
}
