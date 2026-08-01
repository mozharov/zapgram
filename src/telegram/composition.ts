import {register as registerChats} from '@modules/chats/register.js'
import {register as registerInvoices} from '@modules/invoices/register.js'
import {register as registerSubscriptions} from '@modules/subscriptions/register.js'
import {register as registerTipping} from '@modules/tipping/register.js'
import {register as registerWallet} from '@modules/wallet/register.js'
import {walletCommand} from '@modules/wallet/telegram/handlers/wallet-command.js'
import type {BotContext} from '@telegram/context.js'
import {errorHandler} from '@telegram/handlers/error.js'
import {helpCommand} from '@telegram/handlers/help.js'
import {helpCallback} from '@telegram/handlers/help-callback.js'
import {startCommand} from '@telegram/handlers/start.js'
import {unknownCallback} from '@telegram/handlers/unknown-callback.js'
import {attachUser} from '@telegram/middlewares/attach-user.js'
import {conversations} from '@telegram/middlewares/conversations.js'
import {i18n} from '@telegram/middlewares/i18n.js'
import {lnbitsWallet} from '@telegram/middlewares/lnbits-wallet.js'
import {logger} from '@telegram/middlewares/logger.js'
import type {Bot} from 'grammy'

/**
 * Registers all grammY middleware and feature modules.
 * Order is load-bearing: errorBoundary → conversations → logger → i18n,
 * then shared private middleware, feature registers, then terminal handlers
 * (unknownCallback before on('message')).
 */
export function registerHandlers(bot: Bot<BotContext>): void {
  const composer = bot.errorBoundary(errorHandler)
  composer.use(conversations)
  composer.use(logger)
  composer.use(i18n)

  const privateChat = composer.chatType('private')
  privateChat.use(attachUser)
  privateChat.use(lnbitsWallet)

  // Shell commands available before feature modules
  privateChat.command('start', startCommand)
  privateChat.command('help', helpCommand)
  privateChat.callbackQuery('help', helpCallback)

  registerWallet(composer)
  registerTipping(composer)
  registerInvoices(composer)
  registerChats(composer)
  registerSubscriptions(composer)

  // Terminal: catch-all unknown callbacks, then default private message → wallet
  privateChat.on('callback_query', unknownCallback)
  privateChat.on('message', walletCommand)
}
