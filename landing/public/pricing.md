# Pricing — ZapGram

Machine-readable summary for crawlers and AI agents. Human-facing detail lives on the landing page.

## Free (everyone)

- Price: $0
- Open https://t.me/zap_gram_bot — wallet created on first open
- Included:
  - Lightning wallet inside Telegram
  - Send / receive sats (BOLT11 invoices + QR)
  - Username transfers between ZapGram users
  - Group and channel tips (`/tip`)
  - Optional Nostr Wallet Connect (NWC)
  - Optional project support (`/donate`, voluntary % — see below)
  - Russian and English bot UI

## Transfer fees

| Transfer type | Fee |
|---------------|-----|
| ZapGram → ZapGram (internal) | Free |
| External Lightning pay/receive | Lightning network fees (not set by ZapGram) |

## Optional project support (not mandatory)

Users may support the bot author. This is **not** the paid-chat platform fee.

- Voluntary % on top of tips and invoice pays (new accounts default **5%**; change or disable in `/settings`)
- One-shot and monthly donations via `/donate`
- External Lightning address: `zapgram@getalby.com` (recurring possible via third-party tools such as ZapPlanner)
- Auto-% never blocks the main payment

## Paid chats (hosted bot)

Owners can gate private groups/channels with a sat price (one-time permanent access or monthly subscription).

- Member pays: the owner-set price in sats via Lightning invoice
- Owner receives: payout minus platform fee
- Platform fee (hosted bot): default **5%** of owner payouts (`SUBSCRIPTION_FEE_PERCENT`; operators may configure including 0)
- Duplicate payments: refunded safely
- Monthly renewals: can auto-debit from ZapGram wallet balance

## Self-host

- License: MIT — https://github.com/mozharov/zapgram
- Economics: operator-defined (including zero platform fee)

## Currency

All product prices and tips are denominated in **sats** (Bitcoin Lightning). There is no fiat checkout layer on ZapGram.
