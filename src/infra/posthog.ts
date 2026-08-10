import type {AppConfig} from '@config'
import {AppError} from '@core/errors/app-error.js'
import {PostHog} from 'posthog-node'
import {serializeError} from 'serialize-error'

/** PostHog group type for Telegram chats (groups, supergroups, channels). */
export const TELEGRAM_CHAT_GROUP_TYPE = 'telegram_chat' as const

/** Product event for domain failures (user-facing AppError). Not Error Tracking. */
export const APP_ERROR_EVENT = 'app_error' as const

export type CaptureClient = Pick<PostHog, 'capture' | 'captureException'>

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

/**
 * Product event for a Telegram user outside request context (jobs, settle, renewal).
 * Always pass an explicit distinctId — there is no posthog.withContext on cron paths.
 */
export function captureUserEvent(
  posthog: CaptureClient | undefined,
  event: string,
  distinctId: number | string,
  properties?: Record<string, unknown>,
  options?: {chatId?: number},
): void {
  if (!posthog) return
  posthog.capture({
    event,
    distinctId: telegramUserDistinctId(distinctId),
    properties,
    groups: options?.chatId !== undefined ? telegramChatGroups(options.chatId) : undefined,
  })
}

/** Flatten Error (and unknown) into event properties for product + exception captures. */
export function errorProperties(error: unknown): Record<string, unknown> {
  if (error === undefined || error === null) return {}
  const serialized = serializeError(error) as Record<string, unknown>
  const analytics =
    typeof error === 'object' &&
    error !== null &&
    'analytics' in error &&
    error.analytics &&
    typeof error.analytics === 'object'
      ? (error.analytics as Record<string, unknown>)
      : undefined
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  return {
    error_name: typeof serialized.name === 'string' ? serialized.name : undefined,
    error_message:
      typeof serialized.message === 'string' ? serialized.message : String(error).slice(0, 500),
    error_stack: typeof serialized.stack === 'string' ? serialized.stack.slice(0, 4000) : undefined,
    error: serialized,
    ...(code ? {error_code: code} : {}),
    ...analytics,
  }
}

/**
 * Domain AppError → product event `app_error` (expected, filterable, not Error Tracking).
 * Anything else → `$exception` via captureException.
 *
 * Use this from Telegram middleware and job/service paths so normal refusals
 * (to_bot, insufficient_funds, …) do not create exception issues.
 */
export function captureBotError(
  posthog: CaptureClient | undefined,
  error: unknown,
  distinctId?: number | string,
  properties?: Record<string, unknown>,
): void {
  if (!posthog) return
  try {
    if (error instanceof AppError) {
      posthog.capture({
        event: APP_ERROR_EVENT,
        ...(distinctId !== undefined ? {distinctId: telegramUserDistinctId(distinctId)} : {}),
        properties: {
          expected: true,
          error_code: error.code,
          ...(error.params ?? {}),
          ...(error.analytics ?? {}),
          ...errorProperties(error),
          ...properties,
        },
      })
      return
    }
    if (!posthog.captureException) return
    posthog.captureException(
      error,
      distinctId !== undefined ? telegramUserDistinctId(distinctId) : undefined,
      {
        expected: false,
        ...errorProperties(error),
        ...properties,
      },
    )
  } catch {
    // Analytics must never throw into request / money paths.
  }
}

/**
 * Exception for a Telegram user (jobs / services outside request middleware).
 * AppError is recorded as expected `app_error`; other throws go to Error Tracking.
 * Prefer this over bare captureException so distinct_id is always set.
 */
export function captureUserException(
  posthog: CaptureClient | undefined,
  error: unknown,
  distinctId: number | string,
  properties?: Record<string, unknown>,
): void {
  captureBotError(posthog, error, distinctId, properties)
}
