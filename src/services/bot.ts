import type {ChatAdministratorRights} from 'grammy/types'
import {bot} from '../bot/bot.js'
import {setWebhook} from '../bot/webhook.js'
import {config} from '../config.js'
import {tunnelUrl} from '../lib/tunnel.js'
import {logger} from '../lib/logger.js'

export async function configureBot() {
  logger.info('Setting bot commands, webhook and default admin rights...')
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

  if (config.NGROK_TOKEN && tunnelUrl) await setWebhook(tunnelUrl)
  else await setWebhook(config.HOST)

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
  logger.info('Bot commands, webhook and default admin rights were set successfully')
}
