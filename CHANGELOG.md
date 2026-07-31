# Changelog

## Unreleased

**Agents are told who the other agents are.** `up` now appends a short briefing
to each session's system prompt — the agent's own name and private channel, the
shared channels it's in, and the other agents with their working directories.
`aquila up --no-brief` skips it.

Previously an agent in a shared channel had no idea it wasn't alone, and you had
to explain the setup by hand every time. The plugin's own instructions are
thorough about Discord mechanics but describe a world with exactly one agent in
it.

Mostly, though, this is about a constraint that bites the moment an agent *does*
learn siblings exist: it will try to delegate by @mentioning one, and the plugin
drops bot-authored messages, so nothing is delivered and nothing errors. The
agent is then free to report a handoff that never happened. The briefing says
outright that it cannot pass work to another agent and should not claim to.

Session-scoped rather than channel-scoped — there is no hook to inject text on
joining a channel — so shared channels are named up front. The roster is rebuilt
on every `up`, so an agent already running when you `aquila add` another won't
know about the newcomer until it restarts.

**Other people can trigger agents, if you say so.** Shared channels allowed only
you, and dropped everyone else before the mention check — silently, so a
colleague @-mentioning an agent saw nothing at all.

```sh
aquila allow                  # who currently can
aquila allow trz              # by @handle, display name, or nickname
aquila allow --remove trz
aquila allow --anyone         # any server member, still @mention-gated
aquila allow --owner-only     # back to just you
```

Names, not snowflakes, in both directions: `allowFrom: ["1021487254104973352"]`
is not a control anyone can audit by eye. Lookups use
`GET /guilds/{id}/members/search`, which works on an ordinary bot token —
`GET /guilds/{id}/members` does not, needing the privileged `GUILD_MEMBERS`
intent. Ambiguous names list the candidates rather than guessing, and an exact
handle always wins over a prefix match.

The default is unchanged, and this reaches shared channels only: an agent's
private channel stays yours whatever the guest list says. Adding a bot is
refused, since the plugin drops inbound bot messages anyway. `aquila status` now
prints the policy in force.

**Agents find their own channels.** Every agent now joins each channel its bot
can see, not just the private one Aquila made for it. `init`, `add`, `up` and
`status` refresh this in passing; `aquila sync` forces it, `aquila sync --off`
stops it, and `--no-auto-channels` skips one run.

This closes a gap with a bad failure mode. The channel plugin gates guild
channels behind an explicit per-channel opt-in and drops everything else
silently — no reply, no error, not even the ack reaction, since that fires after
the gate. Aquila seeded exactly one entry per agent, so a channel you created by
hand was unreachable until you hand-edited JSON in every state dir, and a bot
sitting in it looked dead.

Detection probes `GET /channels/{id}` — 403 without `VIEW_CHANNEL`, 200 with it
— rather than recomputing role ordering, category inheritance and admin bypass
locally and being quietly wrong. `GET /guilds/{id}/channels` can't be used for
this: it returns every channel's metadata regardless of access.

Discovered channels get `requireMention: true`, unlike an agent's own channel,
because a shared room needs you to address one agent at a time. They keep
`allowFrom: [<owner>]`, so this widens where you can summon an agent, never who
can drive it. Agents never join each other's private channels, and groups you
added by hand are never modified or retracted — Aquila records its own entries
in `auto-channels.json` beside the access file.

## 0.1.1

Token collection, mostly — the part of setup you actually touch by hand.

**Applications are created one at a time, and the prompt now says so.** A
Discord bot token is displayed once and can only be recovered by resetting it.
The previous wording ("create N applications") implied you should make them all
before running `aquila init`, which loses every token but the last to the
clipboard. The interaction was always one-at-a-time; only the instructions
disagreed. It now says so up front and prints `Now create the next application
(2 of 3)` between prompts.

**A token whose application is already in use is rejected.** Two agents sharing
one bot means both sessions open a gateway with the same token, so every message
is delivered twice and answered twice. The check covers a repeat within one run,
a repeat across `--web` rows, and a token belonging to an agent that already
exists — the case `aquila add` is most likely to hit.

**Pasted tokens are visible enough to check.** The first four characters echo as
you type, and the accepted token is repeated abbreviated beside the application
name:

```
backend      token › MTUz••••••••••••••••••••
             ✓ MTUz…Xq4A  app "Orders API"
```

Only the trailing hmac of a Discord token is secret; the leading characters
encode the public application id.

**Internal:** CI now typechecks on every push and pull request, and fails the
build if `npm publish` would rewrite `package.json` — the check that would have
caught 0.1.0 shipping without its `bin` entry.

## 0.1.0

First release.

`init`, `add`, `up`, `down`, `status`, `move`, and `set`. One Discord bot per
agent, one channel per agent, each backed by its own Claude Code session in its
own working directory, with channel isolation enforced by Discord rather than by
routing code.
