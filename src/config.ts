import 'dotenv/config'
import {parseEnv, z} from 'znv'
import type {UserFromGetMe} from 'grammy/types'

export const config = {
  ...parseEnv(process.env, {
    NODE_ENV: z.enum(['development', 'production']).default('production'),
    PORT: z.coerce.number().default(8443),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    BOT_TOKEN: z.string().nonempty(),
    BOT_WEBHOOK_SECRET: z.string().nonempty(),
    BOT_ID: z.coerce.number().optional(),
    BOT_NAME: z.string().optional(),
    BOT_USERNAME: z.string().optional(),
    NGROK_TOKEN: z.string().optional(),
    DB_URL: z.string().nonempty(),
    DB_MIGRATE: z.coerce.boolean().default(true),
    LNBITS_URL: z.string().nonempty(),
    LNBITS_ADMIN_KEY: z.string().nonempty(),
    LNBITS_ADMIN_ID: z.string().nonempty(),
  }),

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
    }
  },

  get memoFooter(): string {
    return `Powered by t.me/${this.BOT_USERNAME}`
  },
}
