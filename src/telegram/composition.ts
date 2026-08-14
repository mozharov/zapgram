import {createConversation} from '@grammyjs/conversations'
import {register as registerBroadcast} from '@modules/broadcast/register.js'
import {broadcasting} from '@modules/broadcast/telegram/conversations/broadcasting.js'
import {register as registerChats} from '@modules/chats/register.js'
import {changingPrice} from '@modules/chats/telegram/conversations/changing-price.js'
import {editCustomMessage} from '@modules/chats/telegram/conversations/edit-custom-message.js'
import {enablingOnchain} from '@modules/chats/telegram/conversations/enabling-onchain.js'
import {register as registerDonations} from '@modules/donations/register.js'
import {customDonateAmount} from '@modules/donations/telegram/conversations/custom-donate-amount.js'
import {customDonationPercent} from '@modules/donations/telegram/conversations/custom-donation-percent.js'
import {customMonthlyAmount} from '@modules/donations/telegram/conversations/custom-monthly-amount.js'
import {register as registerFeatureRequests} from '@modules/feature-requests/register.js'
import {requestingFeature} from '@modules/feature-requests/telegram/conversations/requesting-feature.js'
import {register as registerInvoices} from '@modules/invoices/register.js'
import {creatingInvoice} from '@modules/invoices/telegram/conversations/creating-invoice.js'
import {payingInvoice} from '@modules/invoices/telegram/conversations/paying-invoice.js'
import {register as registerSubscriptions} from '@modules/subscriptions/register.js'
import {register as registerTipping} from '@modules/tipping/register.js'
import {sendingToUser} from '@modules/tipping/telegram/sending-to-user.js'
import {privateMyChatMemberHandler} from '@modules/users/telegram/handlers/private-my-chat-member.js'
import {register as registerWallet} from '@modules/wallet/register.js'
import {connectingNWC} from '@modules/wallet/telegram/conversations/connecting-nwc.js'
import {walletCommand} from '@modules/wallet/telegram/handlers/wallet-command.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {errorHandler} from '@telegram/handlers/error.js'
import {helpCommand} from '@telegram/handlers/help.js'
import {helpCallback} from '@telegram/handlers/help-callback.js'
import {startCommand, startGroupCommand} from '@telegram/handlers/start.js'
import {unknownCallback} from '@telegram/handlers/unknown-callback.js'
import {attachUser} from '@telegram/middlewares/attach-user.js'
import {conversations} from '@telegram/middlewares/conversations.js'
import {i18n} from '@telegram/middlewares/i18n.js'
import {lnbitsWallet} from '@telegram/middlewares/lnbits-wallet.js'
import {logger} from '@telegram/middlewares/logger.js'
import {posthogMiddleware} from '@telegram/middlewares/posthog.js'
import type {Bot} from 'grammy'

export const shellCommands = ['start', 'help'] as const

/** Single source of truth for every persisted grammY conversation installed by the bot. */
export const registeredConversations = [
  connectingNWC,
  sendingToUser,
  payingInvoice,
  creatingInvoice,
  changingPrice,
  editCustomMessage,
  enablingOnchain,
  customDonateAmount,
  customDonationPercent,
  customMonthlyAmount,
  requestingFeature,
  broadcasting,
] as const

/**
 * Registers all grammY middleware and feature modules.
 * Order is load-bearing: errorBoundary → logger → posthog → conversations → i18n,
 * then shared private middleware, all createConversation plugins (before any command),
 * feature registers, then terminal handlers (unknownCallback before on('message')).
 */
export function registerHandlers(bot: Bot<BotContext>): void {
  const composer = bot.errorBoundary(errorHandler)
  composer.use(logger)
  composer.use(posthogMiddleware)
  composer.use(conversations)
  composer.use(i18n)

  const privateChat = composer.chatType('private')
  privateChat.use(attachUser)
  privateChat.use(lnbitsWallet)

  // Every conversation sits above every command and callback so an active conversation
  // always sees the next update and cancels on unrelated input. Module registers only
  // install their own command/callback handlers — not createConversation.
  for (const conversation of registeredConversations) {
    privateChat.use(createConversation(conversation))
  }

  // Shell commands available before feature modules
  privateChat.command(shellCommands[0], startCommand)
  privateChat.command(shellCommands[1], helpCommand)
  privateChat.callbackQuery(staticCallback.help, helpCallback)
  privateChat.on('my_chat_member', privateMyChatMemberHandler)

  // Telegram auto-sends `/start@botusername` into the group when the bot is added via the
  // "Add to Group" menu button — clean that up (see start.ts).
  composer.chatType(['group', 'supergroup']).command(shellCommands[0], startGroupCommand)

  registerWallet(composer)
  registerTipping(composer)
  registerInvoices(composer)
  registerChats(composer)
  registerSubscriptions(composer)
  registerDonations(composer)
  registerFeatureRequests(composer)
  registerBroadcast(composer)

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
