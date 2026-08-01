/**
 * Minimal Discord REST client.
 *
 * Deliberately not discord.js — provisioning is a dozen one-shot HTTP calls and
 * pulling in a gateway library for that costs a 200ms import and a lot of surface
 * area. The gateway client (which does need discord.js) is a separate concern.
 */

const API = 'https://discord.com/api/v10'

export class DiscordError extends Error {
  readonly status: number
  /** Discord's own error code, distinct from the HTTP status. */
  readonly code: number | undefined
  readonly body: unknown

  constructor(status: number, code: number | undefined, message: string, body: unknown) {
    super(message)
    this.name = 'DiscordError'
    this.status = status
    this.code = code
    this.body = body
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/**
 * One request, with 429 handling. Discord returns retry_after in *seconds* as a
 * float; we honour it up to `maxRetries` times.
 */
export async function rest<T>(
  token: string,
  method: Method,
  path: string,
  body?: unknown,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Aquila (https://github.com/pid1lab/aquila, 0.2.0)',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (res.status === 429 && attempt < maxRetries) {
      const retry = (await res.json().catch(() => ({}))) as { retry_after?: number }
      await Bun.sleep(Math.ceil((retry.retry_after ?? 1) * 1000))
      continue
    }

    if (res.status === 204) return undefined as T

    const text = await res.text()
    const parsed = text ? safeJson(text) : undefined

    if (!res.ok) {
      const err = parsed as { message?: string; code?: number } | undefined
      throw new DiscordError(
        res.status,
        err?.code,
        err?.message ?? `${method} ${path} failed with ${res.status}`,
        parsed ?? text,
      )
    }

    return parsed as T
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Encode an image file as a data URI, the form Discord wants for avatars/icons. */
export async function imageDataUri(path: string): Promise<string> {
  const file = Bun.file(path)
  const type = file.type || 'image/png'
  const b64 = Buffer.from(await file.arrayBuffer()).toString('base64')
  return `data:${type};base64,${b64}`
}
