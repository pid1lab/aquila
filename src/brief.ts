/**
 * What an agent is told about the others, appended to its system prompt at spawn.
 *
 * The channel plugin's own instructions are thorough about Discord mechanics —
 * how messages arrive, how to reply, how attachments work — but describe a world
 * with exactly one agent in it. An agent in a shared channel therefore doesn't
 * know its own name, that siblings exist, or which channels it shares with them.
 *
 * The part that actually matters is the constraint. `msg.author.bot` returns
 * early in the plugin's gate, so a message from one agent never reaches another.
 * An agent told only that siblings exist will try to delegate by @mentioning
 * one, get no error because nothing failed, and report the handoff as done. The
 * briefing exists mostly to close that hole; the roster is the pleasant part.
 *
 * This is session-scoped, not channel-scoped — there is no hook to inject text
 * when a particular channel is joined, so the briefing names the shared channels
 * up front instead.
 */

import type { Agent, Config } from './config.ts'

/** Where this agent can actually be reached, resolved to names. */
export interface Reach {
  /** Its private channel, if the name resolved. */
  own?: string
  /** Channels it shares with other agents or people. */
  shared: string[]
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Nothing here is secret, but it is a system prompt — keep it short and factual. */
export function briefingFor(agent: Agent, config: Config, reach: Reach): string {
  const siblings = config.agents.filter(a => a.name !== agent.name)

  const lines: string[] = []

  const own = reach.own
  lines.push(
    `You are the "${agent.name}" agent, reachable on Discord as @${agent.name}.` +
      (own ? ` #${own} is your private channel.` : ''),
  )

  if (!siblings.length) {
    lines.push('You are the only agent on this server.')
    return lines.join('\n')
  }

  lines.push(
    '',
    `You are one of ${config.agents.length} Claude Code agents on this server, each in its own`,
    'working directory:',
    '',
  )
  // Pad from the rendered labels, not the names — "  (you)" is part of the width.
  const rows = config.agents.map(a => ({
    who: `@${a.name}${a.name === agent.name ? '  (you)' : ''}`,
    path: a.path,
  }))
  const width = Math.max(...rows.map(r => r.who.length))
  for (const r of rows) lines.push(`  ${r.who.padEnd(width)}  —  ${r.path}`)

  if (reach.shared.length) {
    lines.push('', `You share ${list(reach.shared.map(n => `#${n}`))} with them.`)
  }

  lines.push(
    '',
    'You cannot hand work to another agent. The Discord plugin drops messages',
    'authored by bots, so @mentioning one does nothing at all — it is not',
    'delivered, and you get no error. Never say you have passed something on.',
    'If work belongs to another agent, say so plainly in your reply and let the',
    'human ask them; they are the one who can.',
    '',
    'You can read what the others say: fetch_messages returns full channel',
    'history, including their replies, so you can pick up context from them',
    'without being told it.',
  )

  return lines.join('\n')
}
