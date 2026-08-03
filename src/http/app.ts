import type {AppConfig} from '@config'
import type {AppLogger} from '@infra/logger.js'
import type {Bot, Context} from 'grammy'
import {createRouter} from './router.js'

type LoggerWithChild = AppLogger & {
  child: (bindings: Record<string, unknown>) => AppLogger
}

export function createHttpApp(deps: {bot: Bot<Context>; config: AppConfig; log: LoggerWithChild}) {
  return createRouter(deps)
}

export function startServer(
  deps: {
    bot: Bot<Context>
    config: AppConfig
    log: LoggerWithChild
  },
  onListening?: () => void,
) {
  return createHttpApp(deps).listen(deps.config.PORT, () => {
    deps.log.info('App is running')
    onListening?.()
  })
}
