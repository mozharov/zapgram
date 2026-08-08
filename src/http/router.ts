import {timingSafeEqual} from 'node:crypto'
import type {AppConfig} from '@config'
import type {AppLogger} from '@infra/logger.js'
import {Elysia} from 'elysia'
import type {Bot, Context} from 'grammy'
import {webhookCallback} from 'grammy'
import {createRequestLogger} from './middlewares/request-logger.js'

type LoggerWithChild = AppLogger & {
  child: (bindings: Record<string, unknown>) => AppLogger
}

export type LnbitsPaymentWebhook = {
  extractPaymentHash: (body: unknown) => string | undefined
  handle: (paymentHash: string) => Promise<unknown>
}

export type SatsPayWebhook = {
  handle: (body: unknown) => Promise<unknown>
}

export function createRouter(deps: {
  bot: Bot<Context>
  config: AppConfig
  log: LoggerWithChild
  lnbitsPaymentWebhook?: LnbitsPaymentWebhook
  satsPayWebhook?: SatsPayWebhook
}) {
  const telegramWebhook = webhookCallback(deps.bot as Bot, 'elysia', {
    secretToken: deps.config.BOT_WEBHOOK_SECRET,
    timeoutMilliseconds: 30_000,
    onTimeout(...args) {
      deps.log.error({args}, 'Telegram webhook timed out')
    },
  })

  return new Elysia({name: 'router'})
    .use(createRequestLogger(deps.log))
    .get('/', () => 'ok')
    .post('/bot', async ctx => {
      const update: unknown = ctx.body
      if (update && typeof update === 'object') {
        Object.assign(update, {reqId: ctx.reqId})
      }
      return telegramWebhook(ctx)
    })
    .post('/lnbits/webhook/:secret', async ctx => {
      if (!deps.lnbitsPaymentWebhook) {
        ctx.set.status = 503
        return {ok: false, error: 'webhook_unconfigured'}
      }
      if (!secretsMatch(ctx.params.secret, deps.config.BOT_WEBHOOK_SECRET)) {
        ctx.set.status = 401
        return {ok: false, error: 'unauthorized'}
      }

      const paymentHash = deps.lnbitsPaymentWebhook.extractPaymentHash(ctx.body)
      if (!paymentHash) {
        ctx.set.status = 400
        return {ok: false, error: 'missing_payment_hash'}
      }

      try {
        const result = await deps.lnbitsPaymentWebhook.handle(paymentHash)
        return {ok: true, result}
      } catch (error) {
        // 200 so LNbits does not hammer retries on our business failures — cron is the safety net.
        deps.log.error({error, paymentHash}, 'LNbits payment webhook handler failed')
        return {ok: false, error: 'handler_failed'}
      }
    })
    .post('/satspay/webhook/:secret', async ctx => {
      if (!deps.satsPayWebhook) {
        ctx.set.status = 503
        return {ok: false, error: 'webhook_unconfigured'}
      }
      if (!secretsMatch(ctx.params.secret, deps.config.BOT_WEBHOOK_SECRET)) {
        ctx.set.status = 401
        return {ok: false, error: 'unauthorized'}
      }

      try {
        const result = await deps.satsPayWebhook.handle(ctx.body)
        return {ok: true, result}
      } catch (error) {
        // 200 so SatsPay does not hammer retries — check-onchain-charges cron is the safety net.
        deps.log.error({error}, 'SatsPay webhook handler failed')
        return {ok: false, error: 'handler_failed'}
      }
    })
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
