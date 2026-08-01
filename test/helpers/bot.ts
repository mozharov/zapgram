import {createBot} from '@infra/telegram/bot.js'
import type {Bot, Context} from 'grammy'
import type {Update} from 'grammy/types'

export type RecordedApiCall = {
  method: string
  payload: unknown
}

export type FakeBot = {
  bot: Bot<Context>
  calls: RecordedApiCall[]
  /** Queue of responses returned to successive API calls (default: {}). */
  respondWith: (responses: unknown[]) => void
  feedUpdate: (update: Update) => Promise<void>
}

/**
 * Bot with a fake API transformer that records outbound calls and returns canned responses.
 * Analogous to Elysia's app.handle(new Request(...)).
 *
 * SCOPE: routing only — "which handler answered this update".
 *
 * grammY runs the LAST installed transformer outermost, so this one intercepts the call before
 * createBot's own `autoRetry()` and `parseMode('HTML')` and, by not calling `prev`, disables them.
 * Outgoing payloads therefore carry no `parse_mode`, and a 429 never triggers a retry. Anything
 * that asserts on the shape of an outgoing request — parse mode, HTML markup, InputFile multipart,
 * retry behaviour — must drive the bot through a fake HTTP Bot API via `client.apiRoot` instead.
 */
export function createFakeBot(token = '000000:test-token'): FakeBot {
  const bot = createBot(token)
  const calls: RecordedApiCall[] = []
  let responses: unknown[] = []
  let responseIndex = 0

  bot.api.config.use(async (_prev, method, payload, _signal) => {
    calls.push({method, payload})
    const next = responses[responseIndex]
    responseIndex++
    if (next instanceof Error) throw next
    // grammY expects the Bot API envelope. Returning a bare result (or {}) makes every call
    // fail with "GrammyError: Call to '<method>' failed!".
    return {ok: true, result: next ?? true} as never
  })

  return {
    bot,
    calls,
    respondWith(next) {
      responses = next
      responseIndex = 0
    },
    async feedUpdate(update) {
      await bot.handleUpdate(update)
    },
  }
}

/** Convenience alias matching the plan name. */
export async function feedUpdate(bot: Bot<Context>, update: Update): Promise<void> {
  await bot.handleUpdate(update)
}
