import {z} from 'zod'

export const envSchema = z.object({
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

export type Env = z.infer<typeof envSchema>
