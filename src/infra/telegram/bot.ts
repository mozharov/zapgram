import {config} from '@config'
import {autoRetry} from '@grammyjs/auto-retry'
import {Bot, type Context} from 'grammy'
import type {UserFromGetMe} from 'grammy/types'
import {parseMode} from './parse-mode.js'

/**
 * Creates a bare Bot instance with retry + HTML parse mode.
 * Must not import @telegram/* or @modules/* — that is what breaks the bot↔services cycle.
 */
export function createBot<C extends Context>(token: string, botInfo?: UserFromGetMe): Bot<C> {
  const instance = new Bot<C>(token, botInfo ? {botInfo} : undefined)
  instance.api.config.use(autoRetry())
  instance.api.config.use(parseMode('HTML'))
  return instance
}

/** Legacy singleton — handlers are registered separately via registerHandlers. Removed in step 11. */
export const bot = createBot(config.BOT_TOKEN, config.botInfo)
