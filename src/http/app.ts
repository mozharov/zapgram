import type {AppConfig} from '@config'
import type {AppLogger} from '@infra/logger.js'
import type {Bot, Context} from 'grammy'
import {createRouter, type LnbitsPaymentWebhook, type SatsPayWebhook} from './router.js'

type LoggerWithChild = AppLogger & {
  child: (bindings: Record<string, unknown>) => AppLogger
}

export type HttpAppDeps = {
  bot: Bot<Context>
  config: AppConfig
  log: LoggerWithChild
  lnbitsPaymentWebhook?: LnbitsPaymentWebhook
  satsPayWebhook?: SatsPayWebhook
}

export function createHttpApp(deps: HttpAppDeps) {
  return createRouter(deps)
}

export function startServer(deps: HttpAppDeps, onListening?: () => void) {
  return createHttpApp(deps).listen(deps.config.PORT, () => {
    deps.log.info('App is running')
    onListening?.()
  })
}
