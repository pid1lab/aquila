# Aquila

**Discord channels for your Claude Code agents.**

One bot per agent, one channel per agent, each backed by its own Claude Code
session in its own working directory. Aquila provisions the bots, scopes the
channels, wires up access control, and runs the sessions.

```sh
aquila init backend=~/src/api frontend=~/src/web
aquila up
```

## Install

```sh
npm install -g @pid1lab/aquila     # or: bunx @pid1lab/aquila
```

**Requirements**

- **[Bun](https://bun.sh)** — `curl -fsSL https://bun.sh/install | bash`. Not just
  for Aquila: the Discord channel plugin's own MCP server runs on Bun, so you
  need it either way.
- **Claude Code** — Aquila drives the `claude` CLI and installs the official
  `discord` channel plugin for you.
- **Linux.** `aquila up` uses `script(1)` with GNU flag syntax and reads
  `/proc` to verify agents are alive; neither holds on macOS. `package.json`
  declares `"os": ["linux"]` so npm refuses to install elsewhere rather than
  failing confusingly at runtime. macOS support is wanted — see the issues.

---

## Concepts

**One bot per agent, always.** The mapping is 1:1 and Aquila never breaks it, so
this document says *agent* throughout and means the bot too. Where the
distinction genuinely matters — the Developer Portal, Discord's own API — it says
so explicitly.

An agent is the durable thing. Everything else either belongs to it permanently
or is a pointer it can be repointed at.

| Entity | What it is | Per agent | Fixed by |
| --- | --- | --- | --- |
| **Application** | what you create in the Developer Portal | one | you, by hand |
| **Bot user** | how the agent appears in Discord | one | Discord — its id *is* the application id |
| **Token** | the credential that *is* the agent's identity | one | Discord, on reset |
| **State dir** | `~/.aquila/agents/<name>/` — token, access policy | one | Aquila |
| **Working directory** | where the session runs | one | `aquila move` |
| **Private channel** | `#<name>`, only this agent and you | one | `aquila init` / `add` |
| **Shared channels** | rooms it joins alongside others | many | `aquila sync` |
| **Session** | the Claude Code conversation it drives | one at a time | `aquila bind` |

The one N:M relationship is shared channels — many agents in many rooms.
Everything else is 1:1.

**Session is a pointer, not a property.** An agent outlives any particular
conversation. `aquila bind` repoints it, and a restart resumes whatever it points
at rather than starting over.

### What binds a session to an agent

A single environment variable:

```
DISCORD_STATE_DIR=/home/you/.aquila/agents/backend
```

A Claude Code session has no idea which agent it is. It inherits that variable
and passes it to the channel plugin, which reads the token and access policy out
of that directory. **Which agent a session is = which state dir it was pointed
at.** Not the working directory, not the process, not `config.json`.

That is why `claude --bg` is unusable here: its daemon hands a pre-warmed session
an earlier invocation's environment, so a second agent inherits the first one's
state dir, both authenticate as the same bot, and every message is answered
twice. It is also why `up` strips every `CLAUDE*` variable before spawning — a
session that inherits the launching session's identity stops being its own.

### What has to be true for a message to reach an agent

Three gates, in order. Only the first announces itself.

| # | Gate | Lives in | Fails as |
| --- | --- | --- | --- |
| 1 | Can the bot see the channel? | Discord permission overwrites | `403`, never delivered |
| 2 | Is the channel opted in? | `access.json` → `groups[id]` | dropped **silently** |
| 3 | This sender, and mentioned if required? | `allowFrom`, `requireMention` | dropped **silently** |

Gate 1 is Discord's and is the real security boundary — it's what makes per-agent
channel isolation trustworthy. Gates 2 and 3 belong to the plugin and are both
silent, which is why an agent that looks dead usually isn't. `aquila sync`
maintains gate 2; `aquila allow` maintains gate 3.

### Where state lives

| Path | Owner | Contents |
| --- | --- | --- |
| `~/.aquila/config.json` | Aquila | agents, paths, ids, session ids, guest list |
| `~/.aquila/agents/<name>/.env` | plugin | `DISCORD_BOT_TOKEN`, mode `0600` |
| `~/.aquila/agents/<name>/access.json` | plugin | who and which channels |
| `~/.aquila/agents/<name>/auto-channels.json` | Aquila | which groups are Aquila's to retract |
| `~/.aquila/agents/<name>/session.log` | Aquila | the detached session's output |
| `<workdir>/.claude/settings.local.json` | Claude Code | pre-approved MCP tools |
| `~/.claude/projects/<encoded-workdir>/<uuid>.jsonl` | Claude Code | conversation transcripts |

`config.json` is a *cache* of Discord's state, not the truth. Delete a channel in
the Discord UI and its `channelId` becomes a dangling pointer with nothing local
noticing. The same applies to `pid`, which is why `status` re-checks `/proc`
rather than trusting it.

### Environment

| Variable | Effect |
| --- | --- |
| `AQUILA_HOME` | where config and state dirs live. Defaults to `~/.aquila`. Set it to run separate fleets side by side. |
| `DISCORD_STATE_DIR` | set by Aquila per agent; what tells a session which agent it is. Not for you to set. |
| `SSH_CONNECTION`, `DISPLAY`, `WAYLAND_DISPLAY` | read to decide whether `--open` can reach a browser |

Agents are spawned with every `CLAUDE*` variable stripped, so a session never
inherits the identity of whatever launched it.

---

## Command reference

Every command. `<required>`, `[optional]`, `...` repeats.

### `aquila init <agent...>`

Provision bots and channels from scratch. Collects a token per agent, enables the
Message Content intent, discovers the server from the first install, captures
your snowflake from its `owner_id`, creates a scoped private channel per agent,
writes tokens and access policy, and installs the channel plugin.

```sh
aquila init backend frontend                       # two agents, both in the cwd
aquila init backend=~/src/api frontend=~/src/web   # explicit directories
aquila init backend --web --port 8080              # paste tokens in a browser
```

| Flag | Effect |
| --- | --- |
| `--web` | collect tokens via a localhost form instead of terminal prompts |
| `--port <n>` | port for `--web` (default 7777) |
| `--rename` | also set each bot's **global** username (~2/hour limit; nickname is set regardless) |
| `--adopt` | take over an existing channel with the agent's name, rewriting its permissions |
| `--open` | open install links in a browser; skipped automatically over SSH with no display |
| `--no-plugin` | skip `claude plugin install` |
| `--no-auto-channels` | skip channel discovery for this run |

**Agent names** are lowercased, and anything outside `a-z 0-9 - _` becomes a dash
— `"My Agent!"` is `my-agent`. The name is the channel name and the bot's server
nickname, so it's worth typing the one you want.

### `aquila add <agent> [path]`

One more agent on the server you already have. Same provisioning, minus server
discovery — the install link comes pre-scoped to your guild, so it's one click.
Path defaults to the cwd.

```sh
aquila add reviewer ~/src/docs
```

Takes every `init` flag except `--no-plugin`. A new agent joins the shared
channels the others are in before it first starts.

### `aquila up [agent...]`

Start agents. Returns as soon as they're spawned; they outlive the shell, but not
a reboot. No names means every agent.

Each runs detached with its own pty and its own `DISCORD_STATE_DIR`. `up`
refreshes channel discovery, resumes each agent's bound conversation, appends the
roster briefing, and waits for the Discord gateway before reporting success —
a session that starts fine and is deaf is the failure worth catching.

```sh
aquila up                # everything
aquila up backend        # one
aquila up --trust        # accept folder-trust for each directory
aquila up --new          # fresh conversation instead of resuming
```

| Flag | Effect |
| --- | --- |
| `--trust` | record Claude Code's folder-trust for each agent's directory |
| `--new` | start a fresh conversation instead of resuming the bound one |
| `--no-brief` | don't tell the agent who the other agents are |
| `--no-auto-channels` | skip channel discovery for this run |

Refuses to start an agent twice: two sessions on one token answer every message
twice.

### `aquila down [agent...]`

Stop agents. SIGTERMs the process group, waits for it to actually die, and
escalates to SIGKILL if it doesn't — it verifies rather than assuming.

```sh
aquila down
aquila down frontend
```

### `aquila status`

Agents, channels, bound sessions, and liveness. Also prints the server, your
snowflake, and who can trigger agents in shared channels.

```
server:  1473397975479881830
owner:   1021487254104973352
trigger: you only

  AGENT     CHANNEL    STATE                    SESSION   PATH
  backend   #backend   connected · pid 2435922  368592fb  /home/you/src/api
  frontend  #frontend  stopped                  c5ae1100  /home/you/src/web
```

`connected` means the gateway is up; `no gateway` means the session is running
but deaf. A running agent whose directory has drifted from config is flagged
`⚠ running in …`. Takes `--no-auto-channels`.

### `aquila sessions [agent...]`

Conversations recorded for each agent's working directory, newest first. `●`
marks the one the agent is bound to.

```
  backend  →  /home/you/src/api

    ● 368592fb   136 turns   253K   23m ago  "Ping"
      f101de6d    23 turns    49K    8h ago  "run whoami and tell me the output"
```

The preview is the first thing you said, with the Discord envelope stripped. Turn
count and size are shown because a resumed session grows until it compacts.

### `aquila bind <agent> <session-id>`

Point an agent at a different conversation. Abbreviated ids work, as printed by
`aquila sessions`. Takes effect on the next start, since the session is fixed at
spawn.

```sh
aquila bind backend 368592fb    # adopt a conversation you had in a terminal
aquila bind backend --new       # start a fresh one
```

### `aquila sync [agent...]`

Opt each agent into every channel its bot can see, and retract channels it has
lost access to. Runs automatically during `init`, `add`, `up` and `status`; the
command forces it after you create a channel.

```sh
aquila sync              # all agents
aquila sync frontend     # one
aquila sync --off        # stop doing it automatically
aquila sync --on         # resume, and sync now
```

Groups you added to `access.json` by hand are never modified or retracted. Agents
never join each other's private channels. Takes effect on running agents without
a restart — the plugin re-reads `access.json` per message.

### `aquila allow [name...]`

Who besides you can trigger an agent in a shared channel. No arguments lists the
current policy. Names in, names out — @handles, display names, server nicknames,
or a raw user id.

```sh
aquila allow                  # who currently can
aquila allow trz              # add someone
aquila allow trz alice        # several at once
aquila allow --remove trz
aquila allow --anyone         # any server member, still @mention-gated
aquila allow --owner-only     # back to just you
```

| Flag | Effect |
| --- | --- |
| `--remove` (`--rm`) | take the named people off the list |
| `--anyone` | any member of the server may trigger agents |
| `--owner-only` | only you |

Never applies to private channels — those stay yours whatever the guest list
says. Ambiguous names list candidates rather than guessing. Bots are refused: the
plugin drops inbound bot messages, so it would do nothing.

### `aquila move <agent> <path>`

Change an agent's working directory. Trust-checks the destination, carries over
tool pre-approval, updates config, and restarts the agent if it was running.

```sh
aquila move backend ~/src/new-api
aquila move backend ~/src/new-api --trust
```

Editing `path` in `config.json` by hand does none of that — the running session
keeps its old directory while `status` reports the new one.

### `aquila set <agent> <key>=<value>`

Change a setting. Currently `claudeArgs`, extra flags for the `claude`
invocation, split on whitespace.

```sh
aquila set backend claudeArgs=--model opus
aquila set backend claudeArgs=          # clear
```

Read at spawn, so it warns when a restart is needed. `path` is redirected to
`move` rather than done halfway.

---

## What Aquila can't do

Two things, both enforced by Discord:

**It can't create the Discord application.** There is no public endpoint. The
Developer Portal drives private routes with a *user* token, and automating that
means driving a user account — self-botting under Discord's ToS, with real
account-termination risk. Aquila does not do it, and neither should anything else
you install. Budget ~40s per agent in the
[portal](https://discord.com/developers/applications): **New Application** → name
it → **Bot** → **Reset Token** → copy.

Do this **one application at a time**, pasting each token into Aquila before
creating the next. A bot token is displayed once and can only be recovered by
resetting it, so creating several up front means losing all but the last to the
clipboard. Aquila prompts for them one by one for exactly this reason.

**It can't create the server.** Discord restricted `POST /guilds` for
applications on 2025-07-15 — bots now get `Bots cannot use this endpoint`, and
guilds that bots did own were transferred to real users. So you create the server
yourself: **+** → **Create My Own** in the Discord client. Three clicks, once —
not per agent.

Everything else is automatic:

| Step | How |
| --- | --- |
| Enable Message Content intent | `PATCH /applications/@me`, `flags: 1<<19` |
| Learn which server you made | `GET /users/@me/guilds` after the first install |
| Learn your snowflake | that guild's `owner_id` — no pairing code, no Developer Mode |
| Create a channel per agent, scoped so each bot sees only its own | `POST /guilds/{id}/channels` with permission overwrites |
| One-click installs for agents 2..N, server pre-selected | `guild_id` + `disable_guild_select=true` |
| Pre-approve the plugin's own tools | `.claude/settings.local.json` per agent |
| Install the channel plugin | `claude plugin install discord@claude-plugins-official` |
| Write tokens and access policy | per-agent state dirs |

The first bot is installed before Aquila knows the server id, so you pick from a
dropdown once. It also carries `PROVISIONER_PERMISSIONS` (adds `MANAGE_CHANNELS`
and `MANAGE_ROLES`) because it creates every agent's channel. Bots after it need
only `AGENT_PERMISSIONS` and install in a single click — and their links are all
printed together so you can work through them back to back while Aquila watches
for every join at once.

The Authorize click itself is Discord's consent gate and can't be automated;
driving a browser session to bypass it would be the same ToS problem as
automating the portal.

For comparison, the official plugin's documented setup is nine steps *per agent*,
including the OAuth2 URL Generator, six permission checkboxes, a pairing-code
exchange, and hunting snowflakes with Developer Mode.

## Why one bot per agent

A single bot could impersonate many agents using webhook `username` overrides,
and that would drop the manual work to one portal trip total. We chose not to,
because separate bots buy things webhooks can't:

- **Native `@mention` autocomplete.** Webhook personas aren't real users, so
  Discord won't autocomplete them. This turns out to matter a lot — it's what
  makes a shared room work (see below).
- **Per-agent typing indicators and presence.** One bot means one ambiguous
  "typing…" no matter which agent is working.
- **Discord-enforced channel isolation.** With separate bots, "the frontend agent
  cannot see #backend" is enforced by Discord — cross-channel reads return 403.
  With one bot it's enforced by our routing code, and a bug there leaks context
  between agents.
- **Native quote-replies.** `POST /webhooks/…` has no `message_reference`
  parameter, so webhook messages cannot reply to anything.

Bot count and session count are independent either way — each agent gets its own
Claude Code session regardless.

## Naming, tokens, and channels

```sh
aquila init backend frontend                       # two agents, in the cwd
aquila init backend=~/src/api frontend=~/src/web   # explicit directories
aquila init backend frontend --web                 # paste tokens in a browser
aquila add reviewer ~/src/docs                     # one more, later
```

**You name each agent; the application can be called anything.** Aquila sets a
**server nickname** so each bot displays as its agent name — matching its
channel — regardless of what you typed in the portal. A nickname is scoped to
your one server, takes display precedence over the username, leaves your
application's global identity alone, and is limited at 20 per 5 minutes.

`--rename` additionally changes the bot's *global* username via
`PATCH /users/@me`. That applies in every server the bot has joined and is
rate-limited to roughly 2/hour, so it's off by default and rarely what you want.

Tokens are collected in one uninterrupted stretch — terminal prompts by default,
so SSH and headless boxes work; `--web` serves a form on localhost for when you
already have the portal open in a browser. Either way each token is validated
against Discord as it lands, so a half-copied paste is caught immediately rather
than three steps later. Both prompt per agent name, so you always know which
agent you're pasting for.

If a channel with the agent's name already exists, Aquila won't quietly create a
duplicate (Discord permits them, and the result is two identical channels with
messages vanishing into the wrong one). A channel that already grants the bot
access is adopted silently — that's a re-run of a partly-finished `init`, and
resuming is correct. Anything else is refused unless you pass `--adopt`, which
rewrites that channel's permissions.

## How agents run

Each agent runs as a detached session with its own pty and its own
`DISCORD_STATE_DIR`, so each connects as its own bot. `up` verifies the Discord
gateway actually came up before reporting success, and refuses to start an agent
twice — two sessions on one token would answer every message twice.

Agents outlive the shell but not a reboot; run `aquila up` again after one.

**First run in a new directory** needs Claude Code's workspace trust. There's no
CLI flag for it, and a detached session blocks forever on a prompt nobody can
see, so `up` checks first and refuses with instructions. `aquila up --trust`
records it. That's deliberately explicit: trusting a folder lets Claude Code
read, edit, and execute everything in it.

> Not `claude --bg`. Its daemon pre-warms spare sessions carrying an earlier
> invocation's environment, so a second agent silently inherits the first agent's
> token and both bots answer every message. Fine for one agent, broken for
> several. Upstream has the same class of bug on Telegram
> ([#4647](https://github.com/anthropics/claude-plugins-official/issues/4647)).

## Why sessions are a pointer

Aquila mints the session id rather than discovering it: `claude --session-id
<uuid>` accepts an id we generate and writes the transcript to `<uuid>.jsonl`,
and `--resume <uuid>` reuses that id instead of forking. So the mapping is a
pointer Aquila owns, and repointing is an edit to config.

The practical effect is that **restarts keep their conversation**. Before this,
`down` then `up` abandoned the transcript and the bot forgot everything.

Resume replays the whole transcript into context, so a long-lived agent's
session grows until it compacts; `aquila sessions` shows size and turn count so
that's visible, and `--new` is the reset. The session is fixed at spawn, so
`bind` takes effect on the next start.

To adopt a conversation you had in a terminal, find it with `aquila sessions`
and `bind` the agent to it — the session is replaced by a bot-backed one, the
history isn't.

## Why `move` exists

A session's working directory is fixed at spawn, so editing `path` in
`~/.aquila/config.json` by hand does nothing to a running agent — it keeps
working in the old directory while `status` reports the new one. `move` avoids
that: it trust-checks the destination, carries over tool pre-approval, updates
config, and restarts the agent if it was running. `status` also flags any
divergence it finds with `⚠ running in …`.

`set` handles the rest. Everything it changes is read at spawn, so it warns when
the agent needs a restart to pick the change up, and it redirects `path` to
`move` rather than doing half the job.

## Permissions

Each agent's working directory gets a `.claude/settings.local.json` pre-approving
the channel plugin's own MCP tools. Without it the agent needs permission to call
`reply` — that is, permission to speak on Discord at all — so every single
message becomes a DM approval. Existing settings are merged, never replaced.

Beyond that, Claude Code auto-approves read-only commands (`ls`, `git log`,
`whoami`), so the approval flow only fires for genuinely consequential actions:
writes outside the workspace, network calls, destructive commands. Those arrive
as a DM with **Allow** / **Deny** / **See more** buttons, and clicking Allow is
independently authenticated against the allowlist.

Prompts go to DM rather than the channel by design — they carry the command or
file path, which would leak to anyone who can read the channel. Upstream declined
channel delivery for that reason
([claude-code#37797](https://github.com/anthropics/claude-code/issues/37797)).
Note `--dangerously-skip-permissions` does **not** cover MCP tools.

## A shared room

Alongside its private channel, every agent joins each channel its bot can see.
Address them with `@backend` — real `@mention` autocomplete, because these are
real bot users.

This exists because the plugin gates guild channels behind an explicit
per-channel opt-in, and drops anything else *silently* — no reply, no error, not
even the ack reaction, which fires after the gate. A bot that hasn't been opted
in is indistinguishable from a bot that's down.

Discovery is a probe, not a calculation. `GET /channels/{id}` answers 403 without
`VIEW_CHANNEL` and 200 with it — ground truth from the same permission code that
decides whether the gateway delivers at all. Computing it locally would mean
reimplementing role ordering, category inheritance and admin bypass, and being
quietly wrong about them. Note that `GET /guilds/{id}/channels` is no substitute:
it returns every channel's metadata regardless of access.

Two rules keep this from widening anything that matters:

- Discovered channels get `requireMention: true`, unlike an agent's private
  channel. In a room several agents share, you address one at a time.
- They allow only you to trigger an agent, until you say otherwise. Discovery
  changes *where* you can summon an agent, never *who* can drive it.

## Letting other people in

Triggering an agent makes a Claude Code session on your machine run a turn, so
by default nobody else can, and their messages are dropped before the mention
check — silently, like everything else this plugin refuses.

```sh
aquila allow                  # who currently can
aquila allow trz              # by @handle, display name, or nickname
aquila allow --remove trz
aquila allow --anyone         # any server member, still @mention-gated
aquila allow --owner-only     # back to just you
```

Names, not snowflakes. `allowFrom: ["1021487254104973352"]` is not a security
control anyone can audit by eye, so Aquila resolves names on the way in and back
to names on the way out — via `GET /guilds/{id}/members/search`, which works on
an ordinary bot token. (`GET /guilds/{id}/members` does not: it needs the
privileged `GUILD_MEMBERS` intent.) A raw id still works if you have one.

This applies only to shared channels. Each agent's private channel stays yours
alone, whatever the guest list says. Adding a bot is refused — the plugin drops
inbound bot messages, so agents cannot wake each other by design.

Guests can *trigger*; they were always able to be *read*. `fetch_messages`
returns unfiltered channel history, so an agent you wake can already see what
everyone else wrote, whether or not they're on the list.

Agents never join each other's private channels; Discord's own overwrites deny
it, and Aquila skips them regardless. A group you add to `access.json` by hand is
left exactly as you wrote it, and never retracted — Aquila tracks which entries
are its own in `auto-channels.json` beside the access file.

Agents can *read* each other in a shared room: `fetch_messages` returns unfiltered
channel history, including other bots' replies. They can't be *woken* by each
other — the plugin drops inbound bot messages — so collaboration works with you as
the scheduler: ask one agent something, then ask another to build on it.

Each agent is told this at startup. `up` appends a short briefing to the system
prompt naming the agent, its private channel, the shared channels it's in, and
the other agents with their working directories. `--no-brief` skips it.

The briefing exists mainly for the constraint. The plugin's own instructions
describe a world with one agent in it, so an agent that learns siblings exist
will try to delegate by @mentioning one — which is dropped, with no error,
leaving it free to report a handoff that never happened. It's told plainly that
it cannot hand work over and shouldn't claim to.

It's session-scoped rather than channel-scoped: there's no hook to inject text
when a channel is joined, so the shared channels are named up front. The roster
is rebuilt on every `up`, so it refreshes on restart — an agent already running
when you `aquila add` another won't know about the newcomer until you restart it.

## Project status

Every command listed above works and are
verified against live Discord.

```sh
bun install
bun spike/provision.ts <throwaway-bot-token> --cleanup
```

The spike exercises the provisioning chain — token → intent flag → bot rename →
discover guild → owner id → scoped channel → invite — and reports which links
hold. If the bot isn't in a server yet it prints an install URL and waits.

Use a throwaway application: the spike renames the bot and creates a channel.

Known gaps: the plugin is installed at user scope, so every Claude Code session
on the machine spawns an idle Discord MCP server; macOS is unsupported (see
Requirements).

## Layout

```
src/
  cli.ts                 command dispatch
  init.ts                provisioning flow — init and add
  tokens.ts              token collection — terminal prompts and the --web form
  up.ts                  agent lifecycle: detached pty sessions, up/down/status
  sync.ts                channel discovery — probe access, maintain access.json
  allow.ts               who may trigger an agent in a shared channel
  brief.ts               the roster each agent is told about at startup
  sessions.ts            which conversation each agent drives — list and bind
  config.ts              ~/.aquila state, per-agent state dirs, settings seeding
  discord/
    rest.ts              minimal REST client with 429 handling
    constants.ts         permission and flag bitfields, from discord-api-types
    people.ts            member search and id→name resolution
    provision.ts         the provisioning chain
spike/
  provision.ts           runnable validation of the chain
```

Aquila sits on top of the official `discord` channel plugin rather than replacing
it — it writes the plugin's `.env` and `access.json`, and launches sessions with
`--channels`. Per-agent isolation comes from `DISCORD_STATE_DIR`.

## License

Apache-2.0 · [PID1 Lab](https://github.com/pid1lab)
