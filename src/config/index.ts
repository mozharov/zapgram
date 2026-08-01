import 'dotenv/config'
import type {UserFromGetMe} from 'grammy/types'
import {z} from 'zod'
import {type Env, envSchema} from './schema.js'

export type AppConfig = Env & {
  readonly botInfo: UserFromGetMe | undefined
  readonly memoFooter: string
  readonly chatsPerPage: number
}

export function createConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`)
  }

  return {
    ...parsed.data,

    get botInfo(): UserFromGetMe | undefined {
      if (!this.BOT_ID || !this.BOT_NAME || !this.BOT_USERNAME) return undefined
      return {
        id: this.BOT_ID,
        first_name: this.BOT_NAME,
        username: this.BOT_USERNAME,
        is_bot: true,
        supports_inline_queries: false,
        can_read_all_group_messages: true,
        can_join_groups: true,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      }
    },

    get memoFooter(): string {
      return `Powered by t.me/${this.BOT_USERNAME}`
    },

    chatsPerPage: 10,
  }
}
