import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {Composer} from 'grammy'
import {createInvoiceCallback} from './telegram/handlers/create-invoice.js'
import {lnInvoiceHears} from './telegram/handlers/ln-invoice.js'
import {payInvoiceCallback} from './telegram/handlers/pay-invoice.js'

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  // createConversation(payingInvoice / creatingInvoice) live in telegram/composition.ts.
  privateChat.callbackQuery(staticCallback.payInvoice, payInvoiceCallback)
  privateChat.callbackQuery(staticCallback.createInvoice, createInvoiceCallback)
  privateChat.hears(/(lnbc[a-z0-9]+)/).use(lnInvoiceHears)
}
