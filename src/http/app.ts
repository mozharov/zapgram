import type {AppConfig} from '@config'
import type {AppLogger} from '@infra/logger.js'
import type {Bot, Context} from 'grammy'
import {createRouter, type LnbitsPaymentWebhook} from './router.js'

type LoggerWithChild = AppLogger & {
  child: (bindings: Record<string, unknown>) => AppLogger
}

export function createHttpApp(deps: {
  bot: Bot<Context>
  config: AppConfig
  log: LoggerWithChild
  lnbitsPaymentWebhook?: LnbitsPaymentWebhook
}) {
  return createRouter(deps)
}

export function startServer(
  deps: {
    bot: Bot<Context>
    config: AppConfig
    log: LoggerWithChild
    lnbitsPaymentWebhook?: LnbitsPaymentWebhook
  },
  onListening?: () => void,
) {
  return createHttpApp(deps).listen(deps.config.PORT, () => {
    deps.log.info('App is running')
    onListening?.()
  })
}
