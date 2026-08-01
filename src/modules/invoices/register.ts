import {createConversation} from '@grammyjs/conversations'
import type {BotContext} from '@telegram/context.js'
import type {Composer} from 'grammy'
import {creatingInvoice} from './telegram/conversations/creating-invoice.js'
import {payingInvoice} from './telegram/conversations/paying-invoice.js'
import {createInvoiceCallback} from './telegram/handlers/create-invoice.js'
import {lnInvoiceHears} from './telegram/handlers/ln-invoice.js'
import {payInvoiceCallback} from './telegram/handlers/pay-invoice.js'

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  privateChat.use(createConversation(payingInvoice))
  privateChat.use(createConversation(creatingInvoice))
  privateChat.callbackQuery('pay-invoice', payInvoiceCallback)
  privateChat.callbackQuery('create-invoice', createInvoiceCallback)
  privateChat.hears(/(lnbc[a-z0-9]+)/).use(lnInvoiceHears)
}
