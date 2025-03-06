import {z} from 'zod'

export const walletResponseSchema = z.array(
  z.object({
    id: z.string(),
    user: z.string(),
    name: z.string(),
    adminkey: z.string(),
    inkey: z.string(),
    deleted: z.boolean(),
    created_at: z.date({coerce: true}),
    updated_at: z.date({coerce: true}),
    currency: z.string().nullable(),
    balance_msat: z.number(),
  }),
)

export const userResponseSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  password: z.string(),
  password_repeat: z.string(),
  pubkey: z.string().nullable(),
  extensions: z.record(z.string()).nullable(),
  extra: z.record(z.unknown()),
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
  memo: z.string(),
  expiry: z.date({coerce: true}),
  webhook: z.string().nullable(),
  webhook_status: z.string().nullable(),
  preimage: z.string().nullable(),
  tag: z.string().nullable(),
  extension: z.string().nullable(),
  time: z.date({coerce: true}),
  created_at: z.date({coerce: true}),
  updated_at: z.date({coerce: true}),
  extra: z.record(z.unknown()),
})
export type PaymentResponse = z.infer<typeof paymentResponseSchema>

export const feeReserveResponseSchema = z.object({
  fee_reserve: z.number(),
})

export const lookupPaymentResponseSchema = z.object({
  paid: z.boolean(),
  preimage: z.string().nullable(),
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

export const balanceResponseSchema = z.object({
  name: z.string(),
  balance: z.number(),
  id: z.string(),
})
