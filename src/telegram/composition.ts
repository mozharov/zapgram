import {createConversation} from '@grammyjs/conversations'
import {register as registerChats} from '@modules/chats/register.js'
import {changingPrice} from '@modules/chats/telegram/conversations/changing-price.js'
import {editCustomMessage} from '@modules/chats/telegram/conversations/edit-custom-message.js'
import {register as registerInvoices} from '@modules/invoices/register.js'
import {creatingInvoice} from '@modules/invoices/telegram/conversations/creating-invoice.js'
import {payingInvoice} from '@modules/invoices/telegram/conversations/paying-invoice.js'
import {register as registerSubscriptions} from '@modules/subscriptions/register.js'
import {register as registerTipping} from '@modules/tipping/register.js'
import {sendingToUser} from '@modules/tipping/telegram/sending-to-user.js'
import {register as registerWallet} from '@modules/wallet/register.js'
import {connectingNWC} from '@modules/wallet/telegram/conversations/connecting-nwc.js'
import {walletCommand} from '@modules/wallet/telegram/handlers/wallet-command.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {staticCallback} from '@telegram/callback-data.js'
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

export const shellCommands = ['start', 'help'] as const

/**
 * Registers all grammY middleware and feature modules.
 * Order is load-bearing: errorBoundary → conversations storage → logger → i18n,
 * then shared private middleware, all createConversation plugins (before any command),
 * feature registers, then terminal handlers (unknownCallback before on('message')).
 */
export function registerHandlers(bot: Bot<BotContext>): void {
  const composer = bot.errorBoundary(errorHandler)
  composer.use(conversations)
  composer.use(logger)
  composer.use(i18n)

  const privateChat = composer.chatType('private')
  privateChat.use(attachUser)
  privateChat.use(lnbitsWallet)

  // Every conversation sits above every command and callback so an active conversation
  // always sees the next update and cancels on unrelated input. Module registers only
  // install their own command/callback handlers — not createConversation.
  privateChat.use(createConversation(connectingNWC))
  privateChat.use(createConversation(sendingToUser))
  privateChat.use(createConversation(payingInvoice))
  privateChat.use(createConversation(creatingInvoice))
  privateChat.use(createConversation(changingPrice))
  privateChat.use(createConversation(editCustomMessage))

  // Shell commands available before feature modules
  privateChat.command(shellCommands[0], startCommand)
  privateChat.command(shellCommands[1], helpCommand)
  privateChat.callbackQuery(staticCallback.help, helpCallback)

  registerWallet(composer)
  registerTipping(composer)
  registerInvoices(composer)
  registerChats(composer)
  registerSubscriptions(composer)

  // Terminal handlers must live on a composer created AFTER the feature registers.
  // grammY fixes a child composer's position in the parent chain at chatType() call time,
  // so appending these to `privateChat` above would short-circuit every module registered
  // below it — every command and callback would fall through to the wallet fallback.
  // `cancel` belongs here too: it has to lose to any conversation currently waiting for
  // input, and those conversations are installed above every command on `privateChat`.
  const privateFallback = composer.chatType('private')
  privateFallback.callbackQuery(staticCallback.cancel, replyWithWallet)
  privateFallback.on('callback_query', unknownCallback)
  privateFallback.on('message', walletCommand)
}
