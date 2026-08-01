import 'dotenv/config'
import type {UserFromGetMe} from 'grammy/types'
import {z} from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().default(8443),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  BOT_TOKEN: z.string().min(1),
  BOT_WEBHOOK_SECRET: z.string().min(1),
  BOT_ID: z.coerce.number().optional(),
  BOT_NAME: z.string().optional(),
  BOT_USERNAME: z.string().optional(),
  NGROK_TOKEN: z.string().optional(),
  DB_URL: z.string().min(1),
  DB_MIGRATE: z.stringbool().default(true),
  LNBITS_URL: z.string().min(1),
  LNBITS_ADMIN_KEY: z.string().min(1),
  LNBITS_ADMIN_ID: z.string().min(1),
  LNBITS_FEE_COLLECTION_INVOICE_KEY: z.string().min(1),
  LNBITS_BEARER_TOKEN: z.string().optional(),
  SUBSCRIPTION_FEE_PERCENT: z.coerce.number().default(0.05), // 5%. if 0 - no fee
  HOST: z.string().min(1),
  CONFIGURE_BOT: z.stringbool().default(true), // should call configureBot() on startup
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(z.prettifyError(parsed.error))
  process.exit(1)
}

export const config = {
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
