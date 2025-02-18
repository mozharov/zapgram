// TypeScript doesn't recognize types from @getalby/sdk, so duplicating it from node_modules/@getalby/sdk/dist/NWCClient.d.ts
declare module '@getalby/sdk' {
  export namespace nwc {
    import {Event, EventTemplate, Relay} from 'nostr-tools'
    import {NWCAuthorizationUrlOptions} from './types'
    interface WithDTag {
      dTag: string
    }
    interface WithOptionalId {
      id?: string
    }
    type Nip47SingleMethod =
      | 'get_info'
      | 'get_balance'
      | 'get_budget'
      | 'make_invoice'
      | 'pay_invoice'
      | 'pay_keysend'
      | 'lookup_invoice'
      | 'list_transactions'
      | 'sign_message'
    type Nip47MultiMethod = 'multi_pay_invoice' | 'multi_pay_keysend'
    export type Nip47Method = Nip47SingleMethod | Nip47MultiMethod
    export type Nip47Capability = Nip47Method | 'notifications'
    export interface Nip47GetInfoResponse {
      alias: string
      color: string
      pubkey: string
      network: string
      block_height: number
      block_hash: string
      methods: Nip47Method[]
      notifications?: Nip47NotificationType[]
    }
    export type Nip47GetBudgetResponse =
      | {
          used_budget: number
          total_budget: number
          renews_at?: number
          renewal_period: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
        }
      | object
    export interface Nip47GetBalanceResponse {
      balance: number
    }
    export interface Nip47PayResponse {
      preimage: string
    }
    export interface Nip47MultiPayInvoiceRequest {
      invoices: (Nip47PayInvoiceRequest & WithOptionalId)[]
    }
    export interface Nip47MultiPayKeysendRequest {
      keysends: (Nip47PayKeysendRequest & WithOptionalId)[]
    }
    export interface Nip47MultiPayInvoiceResponse {
      invoices: ({
        invoice: Nip47PayInvoiceRequest
      } & Nip47PayResponse &
        WithDTag)[]
      errors: []
    }
    export interface Nip47MultiPayKeysendResponse {
      keysends: ({
        keysend: Nip47PayKeysendRequest
      } & Nip47PayResponse &
        WithDTag)[]
      errors: []
    }
    export interface Nip47ListTransactionsRequest {
      from?: number
      until?: number
      limit?: number
      offset?: number
      unpaid?: boolean
      /**
       * NOTE: non-NIP-47 spec compliant
       */
      unpaid_outgoing?: boolean
      /**
       * NOTE: non-NIP-47 spec compliant
       */
      unpaid_incoming?: boolean
      type?: 'incoming' | 'outgoing'
    }
    export interface Nip47ListTransactionsResponse {
      transactions: Nip47Transaction[]
    }
    export interface Nip47Transaction {
      type: string
      /**
       * NOTE: non-NIP-47 spec compliant
       */
      state: 'settled' | 'pending' | 'failed'
      invoice: string
      description: string
      description_hash: string
      preimage: string
      payment_hash: string
      amount: number
      fees_paid: number
      settled_at: number
      created_at: number
      expires_at: number
      metadata?: Record<string, unknown>
    }
    export type Nip47NotificationType = Nip47Notification['notification_type']
    export type Nip47Notification =
      | {
          notification_type: 'payment_received'
          notification: Nip47Transaction
        }
      | {
          notification_type: 'payment_sent'
          notification: Nip47Transaction
        }
    export interface Nip47PayInvoiceRequest {
      invoice: string
      metadata?: unknown
      amount?: number
    }
    export interface Nip47PayKeysendRequest {
      amount: number
      pubkey: string
      preimage?: string
      tlv_records?: {
        type: number
        value: string
      }[]
    }
    export interface Nip47MakeInvoiceRequest {
      amount: number
      description?: string
      description_hash?: string
      expiry?: number
      metadata?: unknown
    }
    export interface Nip47LookupInvoiceRequest {
      payment_hash?: string
      invoice?: string
    }
    export interface Nip47SignMessageRequest {
      message: string
    }
    export interface Nip47SignMessageResponse {
      message: string
      signature: string
    }
    export interface NWCOptions {
      authorizationUrl?: string
      relayUrl: string
      walletPubkey: string
      secret?: string
      lud16?: string
    }
    export declare class Nip47Error extends Error {
      /**
       * @deprecated please use message. Deprecated since v3.3.2. Will be removed in v4.0.0.
       */
      error: string
      code: string
      constructor(message: string, code: string)
    }
    /**
     * A NIP-47 response was received, but with an error code (see https://github.com/nostr-protocol/nips/blob/master/47.md#error-codes)
     */
    export declare class Nip47WalletError extends Nip47Error {}
    export declare class Nip47TimeoutError extends Nip47Error {}
    export declare class Nip47PublishTimeoutError extends Nip47TimeoutError {}
    export declare class Nip47ReplyTimeoutError extends Nip47TimeoutError {}
    export declare class Nip47PublishError extends Nip47Error {}
    export declare class Nip47ResponseDecodingError extends Nip47Error {}
    export declare class Nip47ResponseValidationError extends Nip47Error {}
    export declare class Nip47UnexpectedResponseError extends Nip47Error {}
    export declare class Nip47NetworkError extends Nip47Error {}
    export declare class Nip47UnsupportedVersionError extends Nip47Error {}
    export declare const NWCs: Record<string, NWCOptions>
    export interface NewNWCClientOptions {
      providerName?: string
      authorizationUrl?: string
      relayUrl?: string
      secret?: string
      walletPubkey?: string
      nostrWalletConnectUrl?: string
    }
    export declare class NWCClient {
      relay: Relay
      relayUrl: string
      secret: string | undefined
      lud16: string | undefined
      walletPubkey: string
      options: NWCOptions
      version: string | undefined
      static SUPPORTED_VERSIONS: string[]
      static parseWalletConnectUrl(walletConnectUrl: string): NWCOptions
      static withNewSecret(options?: ConstructorParameters<typeof NWCClient>[0]): NWCClient
      constructor(options?: NewNWCClientOptions)
      get nostrWalletConnectUrl(): string
      getNostrWalletConnectUrl(includeSecret?: boolean): string
      get connected(): boolean
      get publicKey(): string
      get supportedVersion(): string
      getPublicKey(): Promise<string>
      signEvent(event: EventTemplate): Promise<Event>
      getEventHash(event: Event): string
      close(): void
      encrypt(pubkey: string, content: string): Promise<string>
      decrypt(pubkey: string, content: string): Promise<string>
      getAuthorizationUrl(options?: NWCAuthorizationUrlOptions): URL
      initNWC(options?: NWCAuthorizationUrlOptions): Promise<unknown>
      /**
       * @deprecated please use getWalletServiceInfo. Deprecated since v3.5.0. Will be removed in v4.0.0.
       */
      getWalletServiceSupportedMethods(): Promise<Nip47Capability[]>
      getWalletServiceInfo(): Promise<{
        versions: string[]
        capabilities: Nip47Capability[]
        notifications: Nip47NotificationType[]
      }>
      getInfo(): Promise<Nip47GetInfoResponse>
      getBudget(): Promise<Nip47GetBudgetResponse>
      getBalance(): Promise<Nip47GetBalanceResponse>
      payInvoice(request: Nip47PayInvoiceRequest): Promise<Nip47PayResponse>
      payKeysend(request: Nip47PayKeysendRequest): Promise<Nip47PayResponse>
      signMessage(request: Nip47SignMessageRequest): Promise<Nip47SignMessageResponse>
      multiPayInvoice(request: Nip47MultiPayInvoiceRequest): Promise<Nip47MultiPayInvoiceResponse>
      multiPayKeysend(request: Nip47MultiPayKeysendRequest): Promise<Nip47MultiPayKeysendResponse>
      makeInvoice(request: Nip47MakeInvoiceRequest): Promise<Nip47Transaction>
      lookupInvoice(request: Nip47LookupInvoiceRequest): Promise<Nip47Transaction>
      listTransactions(
        request: Nip47ListTransactionsRequest,
      ): Promise<Nip47ListTransactionsResponse>
      subscribeNotifications(
        onNotification: (notification: Nip47Notification) => void,
        notificationTypes?: Nip47NotificationType[],
      ): Promise<() => void>
      private executeNip47Request
      private executeMultiNip47Request
      private _checkConnected
      private _checkCompatibility
      private selectHighestCompatibleVersion
    }
  }
}

// TypeScript doesn't recognize types from @getalby/lightning-tools, so duplicating it from node_modules/@getalby/lightning-tools/dist/invoice.d.ts
declare module '@getalby/lightning-tools' {
  export interface KeysendResponse {
    customKey: string
    customValue: string
    destination: string
  }
  export interface LnUrlRawData {
    tag: string
    callback: string
    minSendable: number
    maxSendable: number
    metadata: string
    payerData?: LUD18ServicePayerData
    commentAllowed?: number
    allowsNostr?: boolean
  }
  export interface LnUrlPayResponse {
    callback: string
    fixed: boolean
    min: number
    max: number
    domain?: string
    metadata: string[][]
    metadataHash: string
    identifier: string
    email: string
    description: string
    image: string
    commentAllowed?: number
    rawData: LnUrlRawData
    allowsNostr: boolean
    payerData?: LUD18ServicePayerData
  }
  export type LUD18ServicePayerData = Partial<{
    name: {
      mandatory: boolean
    }
    pubkey: {
      mandatory: boolean
    }
    identifier: {
      mandatory: boolean
    }
    email: {
      mandatory: boolean
    }
    auth: {
      mandatory: boolean
      k1: string
    }
  }> &
    Record<string, unknown>
  export type LUD18PayerData = Partial<{
    name?: string
    pubkey?: string
    identifier?: string
    email?: string
    auth?: {
      key: string
      sig: string
    }
  }> &
    Record<string, unknown>
  export interface NostrResponse {
    names: Record<string, string>
    relays: Record<string, string[]>
  }
  export interface InvoiceArgs {
    pr: string
    verify?: string
    preimage?: string
  }
  export interface Event {
    id?: string
    kind: number
    pubkey?: string
    content: string
    tags: string[][]
    created_at: number
    sig?: string
  }
  export interface ZapArgs {
    satoshi: number
    comment?: string
    relays: string[]
    p?: string
    e?: string
  }
  export interface NostrProvider {
    getPublicKey(): Promise<string>
    signEvent(
      event: Event & {
        pubkey: string
        id: string
      },
    ): Promise<Event>
  }
  export interface ZapOptions {
    nostr?: NostrProvider
  }
  export interface RequestInvoiceArgs {
    satoshi: number
    comment?: string
    payerdata?: LUD18PayerData
  }

  export class Invoice {
    paymentRequest: string
    paymentHash: string
    preimage: string | null
    verify: string | null
    satoshi: number
    expiry: number | undefined
    timestamp: number
    createdDate: Date
    expiryDate: Date | undefined
    description: string | null
    constructor(args: InvoiceArgs)
    isPaid(): Promise<boolean>
    validatePreimage(preimage: string): boolean
    verifyPayment(): Promise<boolean>
    hasExpired(): boolean
  }
}
