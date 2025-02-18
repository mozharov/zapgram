import {config} from '../config.js'
import {bot} from './bot.js'

export async function setWebhook(tunnelUrl: string) {
  await bot.api.setWebhook(`${tunnelUrl}/bot`, {secret_token: config.BOT_WEBHOOK_SECRET})
}

export async function deleteWebhook() {
  await bot.api.deleteWebhook()
}
