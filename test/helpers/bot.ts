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
 * Bot with a fake API transformer that records outbound calls and returns
 * canned responses. Analogous to Elysia's app.handle(new Request(...)).
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
    // grammY expects a JSON-like payload; empty object is fine for most methods in tests.
    return (next ?? {}) as never
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
