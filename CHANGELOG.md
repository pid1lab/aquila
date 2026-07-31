# Changelog

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
