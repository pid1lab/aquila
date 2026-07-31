#!/usr/bin/env bun
/**
 * aquila — Discord channels for your Claude Code agents.
 */

import { runAdd, runInit } from './init.ts'
import { runDown, runStatus, runUp } from './up.ts'
import { runMove, runSet } from './manage.ts'

const USAGE = `
aquila — Discord channels for your Claude Code agents

  aquila init <agent...>       provision bots and channels for each agent
  aquila add <agent> [path]    add one agent to the server you already have
  aquila up [agent...]         start agents (returns immediately)
                               --trust  accept Claude Code's folder-trust
                                        prompt for each agent's directory
  aquila down [agent...]       stop agents
  aquila status                show agents, channels, and session state
  aquila move <agent> <path>   move an agent to a new working directory
  aquila set <agent> k=v       change a setting (claudeArgs)

You name each agent; the application can be called anything. Aquila sets a
server nickname so the bot displays as its agent name.

  aquila init backend frontend
  aquila init backend=~/src/api frontend=~/src/web

up/down with no names act on every agent.

Options for init and add:
  --web            paste tokens in a browser form instead of the terminal
  --port <n>       port for --web (default 7777)
  --rename         also change the bot's *global* username (every server it
                   is in; Discord limits this to ~2/hour, off by default —
                   the server nickname is set automatically regardless)
  --adopt          take over an existing channel that already has the
                   agent's name, rewriting its permissions
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

  case 'move':
    process.exit(await runMove(positional, { trust: rest.includes('--trust') }))
    break

  case 'set':
    process.exit(await runSet(positional))
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
        rename: rest.includes('--rename'),
        adopt: rest.includes('--adopt'),
      }),
    )
    break
  }

  case 'add': {
    if (!positional.length) {
      console.error('usage: aquila add <agent> [path]   (e.g. `aquila add reviewer ~/src/api`)')
      process.exit(1)
    }
    const port = flagValue(rest, '--port')
    process.exit(
      await runAdd(positional, {
        web: rest.includes('--web'),
        port: port ? Number(port) : undefined,
        rename: rest.includes('--rename'),
        adopt: rest.includes('--adopt'),
      }),
    )
    break
  }

  default:
    console.log(USAGE)
    process.exit(command ? 1 : 0)
}
