import Router from '@koa/router'
import {botRouter} from './bot.js'

export const router = new Router()
router.use(botRouter.routes())
