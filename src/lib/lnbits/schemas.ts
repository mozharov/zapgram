import {z} from 'zod'

export const walletResponseSchema = z.array(
  z.object({
    id: z.string(),
    user: z.string(),
    name: z.string(),
    adminkey: z.string(),
    inkey: z.string(),
    deleted: z.boolean().default(false),
    created_at: z.date({coerce: true}),
    updated_at: z.date({coerce: true}),
    currency: z.string().nullable().optional(),
    balance_msat: z.number().default(0),
    extra: z
      .object({
        icon: z.string().default('flash_on'),
        color: z.string().default('primary'),
        pinned: z.boolean().default(false),
      })
      .optional(),
  }),
)

export const userResponseSchema = z.object({
  id: z.string().optional(),
  username: z.string().min(2).max(20).optional(),
  email: z.string().nullable().optional(),
  password: z.string().min(8).max(50).optional(),
  password_repeat: z.string().min(8).max(50).optional(),
  pubkey: z.string().max(64).nullable().optional(),
  external_id: z.string().max(256).optional(),
  extensions: z.array(z.string()).optional(),
  extra: z.record(z.unknown()).optional(),
})

export const usersResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      username: z.string(),
      password_hash: z.string().nullable(),
      pubkey: z.string().nullable(),
      email: z.string().nullable(),
      extra: z.record(z.unknown()),
      created_at: z.date({coerce: true}),
      updated_at: z.date({coerce: true}),
      is_super_user: z.boolean(),
      is_admin: z.boolean(),
      transaction_count: z.number(),
      wallet_count: z.number(),
      balance_msat: z.number(),
      last_payment: z.string().nullable(),
    }),
  ),
  total: z.number(),
})

export const paymentResponseSchema = z.object({
  checking_id: z.string(),
  payment_hash: z.string(),
  wallet_id: z.string(),
  amount: z.number(), // negative integer if outgoing. msats
  fee: z.number(), // negative integer or 0. msats
  bolt11: z.string(),
  fiat_provider: z.string().nullable().optional(),
  status: z.string().default('pending'),
  memo: z.string().optional(),
  expiry: z.date({coerce: true}).nullable().optional(),
  webhook: z.string().nullable().optional(),
  webhook_status: z.string().nullable().optional(),
  preimage: z.string().nullable().optional(),
  tag: z.string().nullable().optional(),
  extension: z.string().nullable().optional(),
  time: z.date({coerce: true}),
  created_at: z.date({coerce: true}),
  updated_at: z.date({coerce: true}),
  extra: z.record(z.unknown()).default({}),
})
export type PaymentResponse = z.infer<typeof paymentResponseSchema>

export const feeReserveResponseSchema = z.object({
  fee_reserve: z.number(),
})

export const lookupPaymentResponseSchema = z.object({
  paid: z.boolean(),
  status: z.string().optional(),
  preimage: z.string().nullable().optional(),
  details: paymentResponseSchema,
})

export const statusResponseSchema = z.object({
  server_time: z.number(),
  up_time: z.number(),
  version: z.string(),
  funding_source: z.string(),
  funding_source_error: z.string().nullable(),
  funding_source_balance_msat: z.number(),
})

export const healthResponseSchema = z.object({
  server_time: z.number(),
  up_time: z.string(),
})

export const balanceResponseSchema = z.object({
  name: z.string(),
  balance: z.number(), // in millisatoshis
  id: z.string(),
})
