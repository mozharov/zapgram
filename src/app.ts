import {Elysia} from 'elysia'
import {config} from './config.js'
import {logger} from './lib/logger.js'
import {router} from './routes/router.js'

export function createApp() {
  return new Elysia().use(router)
}

export function startServer(onListening?: () => void) {
  return createApp().listen(config.PORT, () => {
    logger.info('App is running')
    onListening?.()
  })
}
