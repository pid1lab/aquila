# Aquila

**Discord channels for your Claude Code agents.**

One bot per agent, one channel per agent, each backed by its own Claude Code
session in its own working directory. Aquila provisions the bots, scopes the
channels, wires up access control, and runs the sessions.

```sh
aquila init ~/src/api ~/src/web
aquila up
```

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
only `AGENT_PERMISSIONS` and install in a single click.

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

## Setup

```sh
aquila init ~/src/api ~/src/web     # two agents, in those directories
aquila init                         # prompts for a directory per agent
aquila init ~/src/api --web         # paste tokens in a browser form
aquila add ~/src/docs               # one more, later
```

**Agents are named after their Discord application.** You already name each app
in the portal, so that name becomes the agent's name, its channel name, and the
bot's display name — all agreeing by construction, with no rename. `"Orders API"`
becomes agent `orders-api` and channel `#orders-api`. Duplicates get a numeric
suffix.

Renaming bots to match is available as `--rename`, but Discord rate-limits
username changes to roughly 2/hour per bot, which is exactly why it isn't the
default.

Tokens are collected in one uninterrupted stretch — terminal prompts by default,
so SSH and headless boxes work; `--web` serves a form on localhost for when you
already have the portal open in a browser. Either way each token is validated
against Discord as it lands, so a half-copied paste is caught immediately rather
than three steps later. `--web` needs a directory per agent so the form knows how
many fields to render.

| Flag | Effect |
| --- | --- |
| `--web` | collect tokens in a browser form instead of the terminal |
| `--port <n>` | port for `--web` (default 7777) |
| `--rename` | rename each bot to its agent name (rate-limited, see above) |
| `--adopt` | take over an existing channel with the agent's name |
| `--no-plugin` | skip installing the channel plugin (`init` only) |

If a channel with the agent's name already exists, Aquila won't quietly create a
duplicate (Discord permits them, and the result is two identical channels with
messages vanishing into the wrong one). A channel that already grants the bot
access is adopted silently — that's a re-run of a partly-finished `init`, and
resuming is correct. Anything else is refused unless you pass `--adopt`, which
rewrites that channel's permissions.

## Running agents

```sh
aquila up              # start every agent; returns immediately
aquila up backend      # or just one
aquila status
aquila down
```

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

Agents can also join a common channel alongside their private one. Opt each agent
into it with `requireMention: true` in its `access.json`, and address them with
`@backend` — real `@mention` autocomplete, because these are real bot users.

Agents can *read* each other there: `fetch_messages` returns unfiltered channel
history, including other bots' replies. They can't be *woken* by each other —
the plugin drops inbound bot messages — so collaboration works with you as the
scheduler: ask one agent something, then ask another to build on it.

## Status

`init`, `add`, `up`, `down`, and `status` all work and are verified against live
Discord.

```sh
bun install
bun spike/provision.ts <throwaway-bot-token> --cleanup
```

The spike exercises the provisioning chain — token → intent flag → bot rename →
discover guild → owner id → scoped channel → invite — and reports which links
hold. If the bot isn't in a server yet it prints an install URL and waits.

Use a throwaway application: the spike renames the bot and creates a channel.

Known gaps: no way to change an agent's working directory short of editing
`~/.aquila/config.json`; the plugin is installed at user scope, so every Claude
Code session on the machine spawns an idle Discord MCP server; `script -qfec` is
Linux-specific, so macOS needs work.

## Layout

```
src/
  cli.ts                 command dispatch
  init.ts                provisioning flow — init and add
  tokens.ts              token collection — terminal prompts and the --web form
  up.ts                  agent lifecycle: detached pty sessions, up/down/status
  config.ts              ~/.aquila state, per-agent state dirs, settings seeding
  discord/
    rest.ts              minimal REST client with 429 handling
    constants.ts         permission and application-flag bitfields
    provision.ts         the provisioning chain
spike/
  provision.ts           runnable validation of the chain
```

Aquila sits on top of the official `discord` channel plugin rather than replacing
it — it writes the plugin's `.env` and `access.json`, and launches sessions with
`--channels`. Per-agent isolation comes from `DISCORD_STATE_DIR`.

## License

Apache-2.0 · [PID1 Lab](https://github.com/pid1lab)
