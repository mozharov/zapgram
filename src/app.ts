import Koa from 'koa'
import {logger} from './lib/logger.js'
import {config} from './config.js'
import {requestLogger} from './middlewares/request-logger.js'
import {router} from './routes/router.js'
import {bodyParser} from '@koa/bodyparser'

const app = new Koa()
app.silent = true

app.use(bodyParser())
app.use(requestLogger)
app.use(router.routes())

export function startServer() {
  return app.listen(config.PORT, () => {
    logger.info('App is running')
  })
}
