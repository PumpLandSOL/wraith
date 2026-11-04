# WRAITH

**Money, unseen.** WRAITH is a private, fractional-algorithmic stablecoin on Solana.

- **wUSD** is the stablecoin, $1, backed by USDC deposits on Solana.
- **$WRAITH** is the share token. Every mint, toll and dark-pool fee buys it at market and burns it.
- **Shield** wUSD and your balance becomes a commitment in one Merkle tree. A **private send** spends a note and writes a new one: the ledger records a nullifier and a commitment, never the amount, the sender or the receiver.

Live at [wraithnetwork.net](https://wraithnetwork.net).

## What runs today

| Piece | How it works |
| --- | --- |
| Deposits | Phantom builds a standard USDC `TransferChecked` to the treasury. The server reads the confirmed transaction with `getTransaction`, checks the depositing wallet signed it, and credits exactly the USDC that landed in treasury-owned token accounts. Minimum 50 USDC. |
| Sessions | Every action that moves value carries an ed25519 signature from the wallet (Phantom `signMessage`). Private balances are returned only to the wallet's own signed session. |
| Mint / redeem | Mint is paid fully in USDC: the collateral ratio share (90%) stays in reserve, the rest buys $WRAITH at market and burns it. Redeem reverses it. |
| Shielded pool | SHA-256 commitments and nullifiers, notes encrypted with x25519 + AES-256-GCM, a Merkle root over the pool. |
| The Note | Pay links: shielded wUSD locked behind a random secret; the server stores only its hash. |
| The Seal | Read-only view keys (HMAC-SHA256) that open a statement of a wallet's shielded balance and history. |
| Dark Pool | 1x long/short on SOL, BTC, ETH and US stocks with shielded wUSD, priced off the live exchange tape, capped per wallet and in total. |
| Bonds, Forge, Vigil | Discounted $WRAITH for USDC (vested or locked) and time-boxed staking paid from a fixed pool. They open once $WRAITH has a live market price. |
| Burn | Tolls (30 bps shield/send/unshield, 50 bps redeem) gather in USDC and buy and burn $WRAITH each epoch. |
| Withdrawals | Queued and paid by the treasury within 24 hours. There is no hot key on the server. |

The ledger runs on the WRAITH server today and the USDC sits in the treasury wallet. The roadmap moves wUSD to a Solana program (phase III) and the shielded pool to on-chain zero-knowledge proofs (phase IV).

## Run it

```
npm start                      # http://localhost:8270
node _studio/e2e.cjs           # backend end-to-end: real ed25519 wallets, every ledger action
```

Node 18+. No dependencies.

| Env | Meaning |
| --- | --- |
| `TREASURY` | Solana wallet that receives USDC. Deposits stay closed until it is set. It is never returned by any API. |
| `ADMIN_KEY` | Key for the payout queue endpoints. |
| `DATA_PATH` | Ledger file (put it on a persistent disk). |
| `WRAITH_MINT` | $WRAITH SPL mint: lights up the CA bar, live price, burns and bonds. |
| `SOL_RPCS` | Comma-separated Solana RPC URLs. |
| `MIN_DEPOSIT`, `CR` | Minimum USDC deposit, collateral ratio. |

## License

MIT
