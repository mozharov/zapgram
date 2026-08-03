import type {Bot, Context} from 'grammy'

export async function setWebhook(bot: Bot<Context>, url: string, secret: string): Promise<void> {
  await bot.api.setWebhook(`${url}/bot`, {secret_token: secret})
}

export async function deleteWebhook(bot: Bot<Context>): Promise<void> {
  await bot.api.deleteWebhook()
}
