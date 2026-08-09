import {z} from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().default(8443),
  CHAT_RIGHTS_DELAY_MS: z.coerce.number().default(1500),
  TEMP_MESSAGE_DELAY_MS: z.coerce.number().default(60_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  BOT_TOKEN: z.string().min(1),
  BOT_API_ROOT: z.string().optional(), // local Bot API server; tests point it at a fake
  BOT_WEBHOOK_SECRET: z.string().min(1),
  BOT_ID: z.coerce.number().optional(),
  BOT_NAME: z.string().optional(),
  BOT_USERNAME: z.string().optional(),
  DB_URL: z.string().min(1),
  DB_MIGRATE: z.stringbool().default(true),
  LNBITS_URL: z.string().min(1),
  LNBITS_ADMIN_KEY: z.string().min(1),
  LNBITS_FEE_COLLECTION_INVOICE_KEY: z.string().min(1),
  LNBITS_BEARER_TOKEN: z.string().optional(),
  /** Network string accepted by Watch-Only / SatsPay (Mainnet | Testnet). */
  LNBITS_ONCHAIN_NETWORK: z.enum(['Mainnet', 'Testnet']).default('Mainnet'),
  SUBSCRIPTION_FEE_PERCENT: z.coerce.number().default(0.05), // 5%. if 0 - no fee
  /** Default voluntary donation % for newly created users (0–100 integer). Existing users stay at DB default 0. */
  DONATION_DEFAULT_PERCENT: z.coerce.number().int().min(0).max(100).default(5),
  HOST: z.preprocess(normalizePublicOrigin, z.url()),
  CONFIGURE_BOT: z.stringbool().default(true), // should call configureBot() on startup
  // Empty string from compose `${VAR:-}` means disabled / use compose default host only.
  POSTHOG_PROJECT_TOKEN: z.preprocess(
    v => (v === '' || v === undefined ? undefined : v),
    z.string().min(1).optional(),
  ),
  POSTHOG_HOST: z.preprocess(
    v => (v === '' || v === undefined ? undefined : v),
    z.url().optional(),
  ),
})

export type Env = z.infer<typeof envSchema>

/** Trim, strip trailing slash, default missing scheme to https. */
function normalizePublicOrigin(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim().replace(/\/$/, '')
  if (!trimmed) return trimmed
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
