import type {AppConfig} from '@config'
import type {AppLogger} from '@infra/logger.js'
import {setWebhook} from '@infra/telegram/webhook.js'
import type {Bot, Context} from 'grammy'
import type {ChatAdministratorRights} from 'grammy/types'

const privateCommandsEn = [
  {command: 'wallet', description: 'Main menu and wallet info'},
  {command: 'donate', description: 'Support the project — one-shot, monthly, stats'},
  {command: 'help', description: 'FAQ, links and instructions'},
] as const

const privateCommandsRu = [
  {command: 'wallet', description: 'Меню и информация о кошельке'},
  {command: 'donate', description: 'Поддержать проект — разово, ежемесячно, статистика'},
  {command: 'help', description: 'FAQ, ссылки и инструкции'},
] as const

const adminBroadcastEn = {
  command: 'broadcast',
  description: 'Admin: broadcast update to users by language',
} as const

const adminBroadcastRu = {
  command: 'broadcast',
  description: 'Админ: рассылка обновления пользователям по языку',
} as const

/**
 * Empty-chat **picture** is not settable via Bot API (only BotFather
 * “Edit Description Picture”). Media + regenerate (landing assets):
 *   landing/public/assets/bot-description-{en,ru}.{png,gif}
 *   bun landing/scripts/render-og.mjs
 */

/** Profile “About” — max 120 chars. Shown under the bot name. */
const shortDescriptionEn =
  'Bitcoin Lightning wallet in Telegram: tips, invoices, and paid chats in sats.'
const shortDescriptionRu =
  'Bitcoin Lightning-кошелёк в Telegram: tips, инвойсы и платные чаты в сатоши.'

/** Empty-chat description — max 512 chars. Shown before Start. */
const descriptionEn = `Bitcoin Lightning wallet inside Telegram.

• Send and receive sats (invoices + QR)
• Tips in groups and channels: /tip
• Paid chat access — Lightning and on-chain, one-time or monthly
• Transfers between ZapGram users — instant, zero fee
• Connect any external Lightning wallet via NWC

Tap Start — wallet is created on first open.

Supported by 21ideas — @bitcoin21ideas
Project site: zapgram.mozharov.me`

const descriptionRu = `Bitcoin Lightning-кошелёк внутри Telegram.

• Отправляйте и получайте саты (инвойсы + QR)
• Tips в группах и каналах: /tip
• Платный доступ к чатам — Lightning и on-chain, разовый или ежемесячный
• Переводы между пользователями ZapGram — мгновенно и без комиссии
• Можно подключить любой внешний Lightning-кошелёк через NWC

Нажмите Start — кошелёк создаётся сразу.

Поддерживается сообществом 21 идея — @bitcoin21ideas
Сайт проекта: zapgram.mozharov.me`

export async function configureBot(deps: {
  bot: Bot<Context>
  config: AppConfig
  log: AppLogger
}): Promise<void> {
  const {bot, config, log} = deps
  log.info('Setting bot profile, commands, webhook and default admin rights...')

  await bot.api.setMyShortDescription(shortDescriptionEn)
  await bot.api.setMyShortDescription(shortDescriptionRu, {language_code: 'ru'})
  await bot.api.setMyDescription(descriptionEn)
  await bot.api.setMyDescription(descriptionRu, {language_code: 'ru'})

  await bot.api.deleteMyCommands({scope: {type: 'all_private_chats'}})
  await bot.api.deleteMyCommands({
    scope: {type: 'all_private_chats'},
    language_code: 'ru',
  })
  for (const adminId of config.ADMIN_TELEGRAM_IDS) {
    await bot.api.deleteMyCommands({scope: {type: 'chat', chat_id: adminId}})
    await bot.api.deleteMyCommands({
      scope: {type: 'chat', chat_id: adminId},
      language_code: 'ru',
    })
  }
  
  await bot.api.setMyCommands([...privateCommandsEn], {scope: {type: 'all_private_chats'}})
  await bot.api.setMyCommands([...privateCommandsRu], {
    scope: {type: 'all_private_chats'},
    language_code: 'ru',
  })

  // BotCommandScopeChat replaces the full list for that private chat — include public + admin.
  for (const adminId of config.ADMIN_TELEGRAM_IDS) {
    await bot.api.setMyCommands([...privateCommandsEn, adminBroadcastEn], {
      scope: {type: 'chat', chat_id: adminId},
    })
    await bot.api.setMyCommands([...privateCommandsRu, adminBroadcastRu], {
      scope: {type: 'chat', chat_id: adminId},
      language_code: 'ru',
    })
  }
  // `is_ephemeral`: the /tip message itself stays invisible to the rest of the group (and to other
  // bots) — only the public confirmation of a successful tip is seen by everyone.
  await bot.api.setMyCommands(
    [
      {
        command: 'tip',
        description: 'Send sats: /tip [amount] [username]',
        is_ephemeral: true,
      },
    ],
    {scope: {type: 'all_group_chats'}},
  )
  await bot.api.setMyCommands(
    [
      {
        command: 'tip',
        description: 'Отправить саты: /tip [amount] [username]',
        is_ephemeral: true,
      },
    ],
    {scope: {type: 'all_group_chats'}, language_code: 'ru'},
  )

  await setWebhook(bot, config.HOST, config.BOT_WEBHOOK_SECRET)

  const rights: ChatAdministratorRights = {
    can_delete_messages: true,
    can_invite_users: true,
    can_manage_chat: true,
    can_restrict_members: true,

    can_change_info: false,
    can_delete_stories: false,
    is_anonymous: false,
    can_edit_stories: false,
    can_manage_video_chats: false,
    can_post_stories: false,
    can_promote_members: false,
    can_edit_messages: false,
    can_manage_topics: false,
    can_pin_messages: false,
    can_post_messages: false,
  }

  await bot.api.setMyDefaultAdministratorRights({for_channels: true, rights})
  await bot.api.setMyDefaultAdministratorRights({for_channels: false, rights})
  log.info('Bot profile, commands, webhook and default admin rights were set successfully')
}
