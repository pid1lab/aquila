/**
 * `aquila move` / `aquila set` — editing an agent after it exists.
 *
 * A session's working directory is fixed at spawn, so changing `path` in config
 * does nothing to a running agent: it keeps working in the old directory while
 * every Aquila command reports the new one. `move` exists so config and reality
 * can't drift apart — it also carries over tool pre-approval, checks trust, and
 * restarts the session, none of which a config edit can do.
 */

import { statSync } from 'node:fs'
import { loadConfig, saveConfig, writeAgentSettings, type Agent } from './config.ts'
import { expandHome } from './init.ts'
import { isAgentProcess, isTrusted, markTrusted, runDown, runUp } from './up.ts'

function find(agents: Agent[], name: string): Agent | string {
  const agent = agents.find(a => a.name === name)
  if (agent) return agent
  return `Unknown agent "${name}". Known: ${agents.map(a => a.name).join(', ') || '(none)'}`
}

export async function runMove(
  args: string[],
  options: { trust?: boolean } = {},
): Promise<number> {
  const [name, rawPath] = args
  if (!name || !rawPath) {
    console.error('usage: aquila move <agent> <path>')
    return 1
  }

  const config = await loadConfig()
  const agent = find(config.agents, name)
  if (typeof agent === 'string') {
    console.error(agent)
    return 1
  }

  const path = expandHome(rawPath)

  try {
    if (!statSync(path).isDirectory()) {
      console.error(`\n  ✗ ${path} is not a directory\n`)
      return 1
    }
  } catch {
    console.error(`\n  ✗ ${path} does not exist\n`)
    return 1
  }

  if (path === agent.path) {
    console.log(`\n  ${agent.name} is already in ${path}\n`)
    return 0
  }

  // Same reasoning as `up`: a detached session blocks forever on the trust
  // dialog, so refuse rather than move an agent into a directory it can't run in.
  if (isTrusted(path) === false) {
    if (!options.trust) {
      console.error(`\n  ✗ Claude Code has not been trusted in ${path}\n`)
      console.error(
        '  It would block on the "do you trust this folder?" prompt, which\n' +
          '  nothing can answer in a detached session.\n\n' +
          `  Either run \`claude\` there once and accept, or:\n\n` +
          `      aquila move ${name} ${rawPath} --trust\n`,
      )
      return 1
    }
    if (!markTrusted(path)) {
      console.error(`\n  ✗ could not record trust for ${path}\n`)
      return 1
    }
    console.log(`  ✓ trusted ${path}`)
  }

  // Carry over tool pre-approval, or the agent lands somewhere it needs
  // permission to speak on Discord and every message becomes a DM approval.
  await writeAgentSettings(path)
  console.log(`  ✓ pre-approved channel tools in ${path}`)

  const wasRunning = agent.pid ? isAgentProcess(agent.pid, agent.stateDir) : false
  if (wasRunning) await runDown([name])

  // Reload: runDown rewrote config to clear the pid.
  const fresh = await loadConfig()
  const target = fresh.agents.find(a => a.name === name)
  if (!target) {
    console.error(`\n  ✗ ${name} vanished from config mid-move\n`)
    return 1
  }
  const from = target.path
  target.path = path
  await saveConfig(fresh)
  console.log(`  ✓ ${name}: ${from} → ${path}`)

  if (wasRunning) return runUp([name], { trust: options.trust })

  console.log(`\n  Start it with:\n\n    aquila up ${name}\n`)
  return 0
}

const SETTABLE = ['claudeArgs'] as const

export async function runSet(args: string[]): Promise<number> {
  const [name, ...rest] = args
  const assignment = rest.join(' ')
  if (!name || !assignment.includes('=')) {
    console.error('usage: aquila set <agent> <key>=<value>')
    console.error(`       settable: ${SETTABLE.join(', ')}`)
    return 1
  }

  const eq = assignment.indexOf('=')
  const key = assignment.slice(0, eq).trim()
  const value = assignment.slice(eq + 1).trim()

  // path has restart semantics a generic setter would only get half right.
  if (key === 'path') {
    console.error('\n  ✗ Use `aquila move` to change an agent\'s directory.\n')
    console.error(
      '  Setting it here would leave a running agent working in the old\n' +
        '  directory while status reported the new one, and would skip the\n' +
        '  trust check and tool pre-approval the new directory needs.\n\n' +
        `      aquila move ${name} ${value}\n`,
    )
    return 1
  }

  if (!(SETTABLE as readonly string[]).includes(key)) {
    console.error(`\n  ✗ Unknown key "${key}". Settable: ${SETTABLE.join(', ')}\n`)
    return 1
  }

  const config = await loadConfig()
  const agent = find(config.agents, name)
  if (typeof agent === 'string') {
    console.error(agent)
    return 1
  }

  if (key === 'claudeArgs') {
    agent.claudeArgs = value ? value.split(/\s+/).filter(Boolean) : undefined
  }

  await saveConfig(config)
  console.log(`\n  ✓ ${name}: ${key} = ${value || '(cleared)'}`)

  // Everything settable here is read at spawn, so a live agent won't see it.
  const running = agent.pid ? isAgentProcess(agent.pid, agent.stateDir) : false
  if (running) {
    console.log(`\n  ⚠ ${name} is running and won't pick this up until restarted:`)
    console.log(`\n      aquila down ${name} && aquila up ${name}\n`)
  } else {
    console.log()
  }
  return 0
}
