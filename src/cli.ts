#!/usr/bin/env bun
/**
 * aquila — Discord channels for your Claude Code agents.
 */

import { runInit } from './init.ts'
import { runDown, runStatus, runUp } from './up.ts'

const USAGE = `
aquila — Discord channels for your Claude Code agents

  aquila init <agent...>       provision bots and channels for each agent
  aquila up [agent...]         start agents (returns immediately)
  aquila down [agent...]       stop agents
  aquila status                show agents, channels, and session state

An agent is a name, optionally with a working directory:

  aquila init backend frontend
  aquila init backend=~/src/api frontend=~/src/web

up/down with no names act on every agent.

Options for init:
  --web            paste tokens in a browser form instead of the terminal
  --port <n>       port for --web (default 7777)
  --no-plugin      skip installing the discord channel plugin

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
    process.exit(await runUp(positional))
    break

  case 'down':
    process.exit(await runDown(positional))
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
    console.error('`aquila add` is not implemented yet.')
    process.exit(1)
    break

  default:
    console.log(USAGE)
    process.exit(command ? 1 : 0)
}
