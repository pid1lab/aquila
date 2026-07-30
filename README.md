# Aquila

**Discord channels for your Claude Code agents.**

One bot per agent, one channel per agent, each backed by its own Claude Code
session in its own working directory. Aquila provisions the bots, builds the
server, scopes the channels, wires up access control, and launches the sessions.

```
aquila init backend frontend reviewer
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
| Name the bot, set its avatar | `PATCH /users/@me` |
| Learn which server you made | `GET /users/@me/guilds` after the first install |
| Learn your snowflake | that guild's `owner_id` — no pairing code, no Developer Mode |
| Create a channel per agent, scoped so each bot sees only its own | `POST /guilds/{id}/channels` with permission overwrites |
| One-click installs for agents 2..N, server pre-selected | `guild_id` + `disable_guild_select=true` |
| Install the channel plugin | `claude plugin install discord@claude-plugins-official` |
| Write tokens, access policy, launchers | per-agent state dirs |

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
  Discord won't autocomplete them.
- **Per-agent typing indicators and presence.** One bot means one ambiguous
  "typing…" no matter which agent is working.
- **Discord-enforced channel isolation.** With separate bots, "the frontend agent
  cannot see #backend" is enforced by Discord. With one bot it's enforced by our
  routing code, and a bug there leaks context between agents.
- **Native quote-replies.** `POST /webhooks/…` has no `message_reference`
  parameter, so webhook messages cannot reply to anything.

Bot count and session count are independent either way — each agent gets its own
Claude Code session regardless.

## Setup

```sh
aquila init backend frontend reviewer
aquila init backend=~/src/api frontend=~/src/web      # explicit working dirs
aquila init backend frontend --web                    # paste tokens in a browser
```

Tokens are collected in one uninterrupted stretch — terminal prompts by default,
so SSH and headless boxes work; `--web` serves a form on localhost for when you
already have the portal open in a browser. Either way each token is validated
against Discord as it lands, so a half-copied paste is caught immediately rather
than three steps later.

Then Aquila enables the intent flag on every bot, renames each to its agent name,
walks you through installing them (one dropdown for the first, one click for the
rest), creates a scoped channel each, writes `.env` and `access.json` per agent,
and installs the channel plugin.

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

> Not `claude --bg`: its daemon pre-warms spare sessions carrying an earlier
> invocation's environment, so a second agent silently inherits the first
> agent's token. Fine for one agent, broken for several.

## Status

`init`, `up`, `down`, and `status` work. `add` is a stub.

```sh
bun install
bun spike/provision.ts <throwaway-bot-token> --cleanup
```

The spike exercises the full chain — token → intent flag → bot rename → discover
guild → owner id → scoped channel → invite — and reports which links hold. If the
bot isn't in a server yet it prints an install URL and waits for you.

Use a throwaway application: the spike renames the bot and creates a channel.

Spike results so far (2026-07-30): intent flag and `renameBot` both confirmed
working against a live token. `POST /guilds` confirmed dead for bots, which is
why the server is yours to create.

## Layout

```
src/
  cli.ts                 command dispatch
  init.ts                provisioning flow
  tokens.ts              token collection — terminal prompts and the --web form
  up.ts                  agent lifecycle: detached pty sessions, up/down/status
  config.ts              ~/.aquila state, per-agent state dirs, access.json seeding
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
