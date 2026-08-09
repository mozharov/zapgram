import type {AppConfig} from '@config'
import type {AppLogger} from '@infra/logger.js'
import {setWebhook} from '@infra/telegram/webhook.js'
import type {Bot, Context} from 'grammy'
import type {ChatAdministratorRights} from 'grammy/types'

export async function configureBot(deps: {
  bot: Bot<Context>
  config: AppConfig
  log: AppLogger
}): Promise<void> {
  const {bot, config, log} = deps
  log.info('Setting bot commands, webhook and default admin rights...')
  await bot.api.setMyCommands(
    [
      {
        command: 'wallet',
        description: 'Main menu and wallet info',
      },
      {
        command: 'settings',
        description: 'Wallet settings',
      },
      {
        command: 'subscriptions',
        description: 'Your active subscriptions',
      },
      {
        command: 'chats',
        description: 'Your chats with paid subscriptions',
      },
      {
        command: 'donate',
        description: 'Support the project — one-shot, monthly, stats',
      },
      {
        command: 'feature',
        description: 'Request a feature (optional sats tip)',
      },
      {
        command: 'help',
        description: 'FAQ, links and instructions',
      },
    ],
    {scope: {type: 'all_private_chats'}},
  )
  await bot.api.setMyCommands(
    [
      {
        command: 'wallet',
        description: 'Меню и информация о кошельке',
      },
      {
        command: 'settings',
        description: 'Настройки кошелька',
      },
      {
        command: 'subscriptions',
        description: 'Твои активные подписки',
      },
      {
        command: 'chats',
        description: 'Твои чаты с платным доступом',
      },
      {
        command: 'donate',
        description: 'Поддержать проект — разово, ежемесячно, статистика',
      },
      {
        command: 'feature',
        description: 'Запросить фичу (можно с сатоши)',
      },
      {
        command: 'help',
        description: 'FAQ, ссылки и инструкции',
      },
    ],
    {scope: {type: 'all_private_chats'}, language_code: 'ru'},
  )
  await bot.api.setMyCommands(
    [
      {
        command: 'tip',
        description: 'Send sats: /tip [amount] [username]',
      },
    ],
    {scope: {type: 'all_group_chats'}},
  )
  await bot.api.setMyCommands(
    [
      {
        command: 'tip',
        description: 'Отправить саты: /tip [amount] [username]',
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
  log.info('Bot commands, webhook and default admin rights were set successfully')
}
