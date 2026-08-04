import type {AppConfig} from '@config'
import {PostHog} from 'posthog-node'

/** PostHog group type for Telegram chats (groups, supergroups, channels). */
export const TELEGRAM_CHAT_GROUP_TYPE = 'telegram_chat' as const

/**
 * Long-running bot process: default batching is correct.
 * flushAt=20 / flushInterval=10s (SDK defaults) — no per-event flush needed.
 * Always await shutdown() on process exit (already done in main.ts).
 *
 * flushAt:1 + flushInterval:0 is only for serverless / short-lived processes.
 */
export function createPostHog(config: AppConfig): PostHog | undefined {
  const token = config.POSTHOG_PROJECT_TOKEN
  // Compose always injects a default host; analytics is gated on the project token.
  if (!token) return undefined

  const host = config.POSTHOG_HOST
  if (!host) {
    throw new Error('POSTHOG_HOST is required when POSTHOG_PROJECT_TOKEN is set')
  }

  const client = new PostHog(token, {
    host,
    enableExceptionAutocapture: true,
  })

  void client.register({
    app: 'zapgram',
    environment: config.NODE_ENV,
  })

  return client
}

export function telegramUserDistinctId(userId: number | string): string {
  return String(userId)
}

export function telegramChatGroupKey(chatId: number | string): string {
  return String(chatId)
}

export function telegramChatGroups(chatId: number | string): Record<string, string> {
  return {[TELEGRAM_CHAT_GROUP_TYPE]: telegramChatGroupKey(chatId)}
}
