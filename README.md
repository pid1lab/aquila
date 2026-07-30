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

## The one thing Aquila can't do

**Discord has no public API for creating an application.** The Developer Portal
drives private endpoints with a *user* token, and automating that means driving a
user account — self-botting under Discord's ToS, with real account-termination
risk. Aquila does not do it, and neither should anything else you install.

So for each agent you spend about 40 seconds in the
[Developer Portal](https://discord.com/developers/applications):

1. **New Application** → name it
2. **Bot** → **Reset Token** → copy

That's the whole manual surface. Aquila does the rest:

| Step | How |
| --- | --- |
| Enable Message Content intent | `PATCH /applications/@me`, `flags: 1<<19` |
| Name the bot, set its avatar | `PATCH /users/@me` |
| Create the shared server | `POST /guilds` |
| Create a channel per agent, scoped so each bot sees only its own | `POST /guilds/{id}/channels` with permission overwrites |
| One-click install links, server pre-selected | `guild_id` + `disable_guild_select=true` |
| Capture your snowflake | `GuildMemberAdd` — no pairing codes |
| Write tokens, access policy, launchers | per-agent state dirs |

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

## Status

Early. The provisioning primitives in `src/discord/provision.ts` are written;
the CLI commands that drive them are not.

```sh
bun install
bun spike/provision.ts <throwaway-bot-token> --cleanup
```

The spike exercises the full chain — token → intent flag → bot rename → guild →
scoped channel → invite — and reports which links hold. `renameBot` is the one
step Discord's docs don't confirm works with a bot token; if it fails, per-agent
naming becomes manual portal work and the CLI's flow changes accordingly. Run the
spike before building on it.

Use a throwaway application: the spike creates a real server and renames the bot.

## Layout

```
src/
  cli.ts                 command dispatch
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
