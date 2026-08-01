#!/usr/bin/env bun
/**
 * aquila — Discord channels for your Claude Code agents.
 */

import { runAdd, runInit } from './init.ts'
import { runDown, runStatus, runUp } from './up.ts'
import { runMove, runSet } from './manage.ts'
import { runSync } from './sync.ts'
import { runAllow } from './allow.ts'
import { runBind, runSessions } from './sessions.ts'

const USAGE = `
aquila — Discord channels for your Claude Code agents

  aquila init <agent...>       provision bots and channels for each agent
  aquila add <agent> [path]    add one agent to the server you already have
  aquila up [agent...]         start agents (returns immediately)
                               --trust     accept Claude Code's folder-trust
                                           prompt for each agent's directory
                               --no-brief  don't tell the agent who the other
                                           agents are
                               --new       start a fresh conversation instead
                                           of resuming the agent's own
  aquila sessions [agent...]   conversations in each agent's directory
  aquila bind <agent> <id>     point an agent at a different conversation
                               --new  start a fresh one
  aquila down [agent...]       stop agents
  aquila status                show agents, channels, and session state
  aquila sync [agent...]       opt agents into every channel they can see
                               --off / --on  stop or resume doing this
                                             automatically
  aquila allow [name...]       let other people trigger agents in shared
                               channels; no name lists who currently can
                               --remove <name>  take someone off the list (--rm)
                               --anyone         any member of the server
                               --owner-only     back to just you
  aquila move <agent> <path>   move an agent to a new working directory
  aquila set <agent> k=v       change a setting (claudeArgs)

One bot per agent, always — "agent" below means the bot too. You name each
agent; the application can be called anything. Aquila sets a server nickname
so the bot displays as its agent name.

  aquila init backend frontend
  aquila init backend=~/src/api frontend=~/src/web

up/down with no names act on every agent.

Each agent gets a private channel of its own. Beyond that it joins every
channel its bot can see, and answers there only when @mentioned. Channels
you can't see, it can't either — Discord decides, not Aquila.

Options for init, add, up and status:
  --no-auto-channels   skip channel discovery for this run

Options for init and add:
  --web            paste tokens in a browser form instead of the terminal
  --port <n>       port for --web (default 7777)
  --rename         also change the bot's *global* username (every server it
                   is in; Discord limits this to ~2/hour, off by default —
                   the server nickname is set automatically regardless)
  --adopt          take over an existing channel that already has the
                   agent's name, rewriting its permissions
  --open           try to open install links in a browser (skipped over
                   SSH, where the browser isn't on this machine)
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

const noAutoChannels = rest.includes('--no-auto-channels')

switch (command) {
  case 'status':
    process.exit(await runStatus({ noAutoChannels }))
    break

  case 'up':
    process.exit(
      await runUp(positional, {
        trust: rest.includes('--trust'),
        noAutoChannels,
        noBrief: rest.includes('--no-brief'),
        newSession: rest.includes('--new'),
      }),
    )
    break

  case 'sync':
    process.exit(
      await runSync(positional, { off: rest.includes('--off'), on: rest.includes('--on') }),
    )
    break

  case 'sessions':
    process.exit(await runSessions(positional))
    break

  case 'bind':
    process.exit(await runBind(positional, { fresh: rest.includes('--new') }))
    break

  case 'allow':
    process.exit(
      await runAllow(positional, {
        remove: rest.includes('--remove') || rest.includes('--rm'),
        anyone: rest.includes('--anyone'),
        ownerOnly: rest.includes('--owner-only'),
      }),
    )
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
        open: rest.includes('--open'),
        noAutoChannels,
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
        open: rest.includes('--open'),
        noAutoChannels,
      }),
    )
    break
  }

  default:
    console.log(USAGE)
    process.exit(command ? 1 : 0)
}
