import {config} from '@config'
import {logger} from '@infra/logger.js'
import {Elysia} from 'elysia'
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
