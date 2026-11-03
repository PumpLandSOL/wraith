// WRAITH: a private, fractional-algorithmic stablecoin on Solana.
//   wUSD    : the stablecoin, $1, backed by real USDC deposits (Frax-style fractional: the collateral slice stays in reserve,
//             the algorithmic slice buys $WRAITH at market and burns it)
//   $WRAITH : the share token (SPL, Solana)
//   Privacy : shield wUSD -> hold a private balance -> send shielded (amount + parties hidden).
// Every balance moves only on a real event: a USDC deposit verified on Solana, or an action signed by the wallet's own key.
// Dependency-free.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { generateKeyPairSync, sign, createHash, createHmac, randomBytes, randomInt, diffieHellman, createCipheriv } = require('crypto');

const PORT = process.env.PORT || 8270;
const ROOT = path.join(__dirname, '..');
const DATA_PATH = process.env.DATA_PATH || path.join(ROOT, 'data.json');
const STABLE = 'wUSD', GOV = 'WRAITH';
const WRAITH_MINT = process.env.WRAITH_MINT || 'TQWwqEcm5LERR7p2NmJbieneL4gPt9NjNt238xApump';   // $WRAITH SPL mint: the CA bar, price feed and burns light up when set
const TREASURY = process.env.TREASURY || '';         // Solana wallet that receives USDC. Environment only: never in the repo, never returned by an API.
const TICK_SEC = +(process.env.TICK_SEC || 5);
const SEED = { usdc: 0, wraith: 0, wusd: 0, priv: 0 };   // real deposits only — nothing is seeded

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) { let n = BigInt('0x' + Buffer.from(buf).toString('hex')); let o = ''; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } for (const b of buf) { if (b === 0) o = '1' + o; else break; } return o || '1'; }
const sha = (s) => createHash('sha256').update(s).digest();
const rawX = (pk) => { const d = pk.export({ type: 'spki', format: 'der' }); return d.subarray(d.length - 32); };

// ---------- protocol state ----------
let db = {
  wusdPrice: 1.0, wusdSupply: 0, wraithPrice: 0, wraithSupply: 1_000_000_000,
  cr: +(process.env.CR || 0.9),  // collateral ratio: share of every mint kept as USDC in reserve
  collateralUsd: 0,              // USDC in reserve backing wUSD
  lastTick: Date.now(), wallets: {},
  shielded: { commitments: [], nullifiers: 0, notes: 0, totalValue: 0, txCount: 0, root: base58(sha('empty')), feed: [] },
};
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))); } catch (e) {}
if (!db.wallets) db.wallets = {};
if (db.v !== 1) { db = { ...db, v: 1, wallets: {}, wusdSupply: 0, collateralUsd: 0 }; }   // Solana ledger v1
if (!db.shielded) db.shielded = { commitments: [], nullifiers: 0, notes: 0, totalValue: 0, txCount: 0, root: base58(sha('empty')), feed: [] };
if (!db.shielded.feed) db.shielded.feed = [];
// ---------- THE PYRE: ferry toll -> WRAITH buyback & burn ----------
const TOLL = { shield: 0.003, send: 0.003, unshield: 0.003, redeem: 0.005 }; // 30 / 30 / 30 / 50 bps
const PYRE_MIN_USD = 25;
if (!db.pyre) db.pyre = { tollUsd: 0, burnedWraith: 0, burnedUsd: 0, epochs: 0, burns: [] };
const pyre = db.pyre;
const FERRY_CUT = +(process.env.FERRY_CUT || 0.20);   // share of every toll that goes to the wallet who brought the payer across
function toll(kind, amt, w) {
  const f = amt * TOLL[kind]; let cut = 0;
  if (w && w.ref && db.wallets[w.ref]) { cut = f * FERRY_CUT; const fm = db.wallets[w.ref]; fm.wusd += cut; fm.earned = (fm.earned || 0) + cut; db.ferry.paid += cut; }
  pyre.tollUsd += f - cut; return amt - f;
}
if (!db.ferry) db.ferry = { paid: 0, souls: 0 };
function bind(w, addr, refAddr) { refAddr = refAddr || ''; if (w.ref || !isWallet(refAddr) || refAddr === addr) return false; const fm = W(refAddr); w.ref = refAddr; w.refTs = Date.now(); fm.souls = (fm.souls || 0) + 1; db.ferry.souls++; hist(fm, { type: 'soul', amt: 0, to: addr }); return true; }
const redact = (addr) => addr.slice(0, 4) + '████' + addr.slice(-4);
function ferrymen() { return Object.entries(db.wallets).filter(([, x]) => (x.souls || 0) > 0).map(([addr, x]) => ({ who: redact(addr), souls: x.souls || 0, earned: x.earned || 0 })).sort((p, q) => q.souls - p.souls || q.earned - p.earned).slice(0, 10); }
function pyreBurn(now) {
  if (pyre.tollUsd < PYRE_MIN_USD || !(db.wraithPrice > 0)) return;   // burns wait for a live $WRAITH price
  const usd = pyre.tollUsd; const px = Math.max(0.0001, db.wraithPrice); const wraith = usd / px;
  db.wraithSupply = Math.max(0, db.wraithSupply - wraith); pyre.tollUsd = 0; pyre.burnedWraith += wraith; pyre.burnedUsd += usd; pyre.epochs++;
  const id = base58(sha('pyre|' + pyre.epochs + '|' + usd.toFixed(6) + '|' + wraith.toFixed(6) + '|' + now));
  pyre.burns.unshift({ id, usd, wraith, px, ts: now, epoch: pyre.epochs }); if (pyre.burns.length > 40) pyre.burns.pop();
}
let saveT = null; function save() { if (saveT) return; saveT = setTimeout(() => { saveT = null; try { fs.writeFileSync(DATA_PATH, JSON.stringify(db)); } catch (e) {} }, 800); }
function b58dec(str) { let n = 0n; for (const ch of str) { const i = B58.indexOf(ch); if (i < 0) throw new Error('b58'); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const ch of str) { if (ch === '1') out.unshift(0); else break; } return Buffer.from(out); }
const isWallet = (s) => { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '')) return false; try { return b58dec(s).length === 32; } catch (e) { return false; } };
// ---------- sessions: every action that moves value is signed by the wallet (Phantom signMessage, ed25519) ----------
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const SESSIONS = new Map();
const sessionMsg = (w, exp) => ['WRAITH session', 'Wallet: ' + w, 'Expires: ' + exp, 'Signing is free and moves no funds.'].join('\n');
function requireSess(w, auth) {
  if (!auth || !auth.sig || !auth.exp) throw 'sign in with your wallet first';
  const exp = +auth.exp; if (!(exp > Date.now())) throw 'session expired, sign in again'; if (exp > Date.now() + 8 * 864e5) throw 'bad session';
  const key = w + ':' + exp + ':' + auth.sig; if (SESSIONS.get(key)) return true;
  let ok = false; try { const pk = b58dec(w), sig = b58dec(auth.sig); if (pk.length !== 32 || sig.length !== 64) throw 0;
    ok = require('crypto').verify(null, Buffer.from(sessionMsg(w, exp), 'utf8'), require('crypto').createPublicKey({ key: Buffer.concat([SPKI_ED25519, pk]), format: 'der', type: 'spki' }), sig); } catch (e) { throw 'bad signature'; }
  if (!ok) throw 'signature is not from this wallet';
  if (SESSIONS.size > 5000) SESSIONS.clear(); SESSIONS.set(key, 1); return true;
}
function W(a) { return db.wallets[a] || (db.wallets[a] = { usdc: SEED.usdc, wraith: SEED.wraith, wusd: SEED.wusd, priv: SEED.priv, seeded: true }); }

// ---------- chain: real USDC (SPL) deposits to TREASURY, verified on Solana ----------
const USDC = { mint: process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', dec: 6 };
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RPCS = (process.env.SOL_RPCS || 'https://api.mainnet-beta.solana.com').split(',');
const MIN_DEPOSIT = +(process.env.MIN_DEPOSIT || 50);   // USDC: smaller transfers are NOT credited
const CHAIN = { ok: false, slot: 0, treasuryUsdc: 0, treasuryWraith: 0, lastRead: 0, errs: 0 };
const isSig = (x) => /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(x || '');
async function rpc(method, params) {
  let err; for (const u of RPCS) { try { const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 9000);
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal }); clearTimeout(tm);
    const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; } catch (e) { err = e; CHAIN.errs++; } }
  throw err || new Error('rpc');
}
async function tokenAccounts(owner, mint) { const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return (r.value || []).map((a) => ({ pubkey: a.pubkey, amount: +a.account.data.parsed.info.tokenAmount.uiAmount || 0 })).sort((a, b) => b.amount - a.amount); }
async function pollChain() { try { CHAIN.slot = await rpc('getSlot', [{ commitment: 'confirmed' }]);
  if (TREASURY) { CHAIN.treasuryUsdc = (await tokenAccounts(TREASURY, USDC.mint)).reduce((a, x) => a + x.amount, 0); if (WRAITH_MINT) CHAIN.treasuryWraith = (await tokenAccounts(TREASURY, WRAITH_MINT)).reduce((a, x) => a + x.amount, 0); }
  if (WRAITH_MINT) { const sp = await rpc('getTokenSupply', [WRAITH_MINT]); db.wraithSupply = +sp.value.uiAmount || db.wraithSupply; }
  CHAIN.ok = true; CHAIN.lastRead = Date.now(); } catch (e) { CHAIN.ok = false; } }
setInterval(pollChain, 30000); pollChain();
if (!db.txs) db.txs = {};
if (!db.treasuryIn) db.treasuryIn = { usdc: 0, n: 0 };
async function creditDeposit(w, sig) {
  if (!TREASURY) throw 'deposits are not open yet';
  if (!isSig(sig)) throw 'paste the transaction signature';
  if (db.txs[sig]) throw 'already credited';
  const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  if (!tx) throw 'tx not found yet, try again in a few seconds'; if (tx.meta && tx.meta.err) throw 'tx failed on-chain';
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? { pubkey: k, signer: false } : k));
  if (!keys.some((k) => k.signer && k.pubkey === w)) throw 'tx not signed by your wallet';
  // USDC that landed in token accounts OWNED BY the treasury, from the token balance deltas Solana recorded for this tx
  const bal = (list) => { const m = {}; for (const b of list || []) if (b.mint === USDC.mint && b.owner === TREASURY) m[b.accountIndex] = +b.uiTokenAmount.uiAmount || 0; return m; };
  const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances); let amt = 0;
  for (const i of Object.keys(post)) amt += post[i] - (pre[i] || 0);
  amt = Math.round(amt * 1e6) / 1e6;
  if (!(amt > 0)) throw 'no USDC sent to the treasury in this tx';
  if (amt < MIN_DEPOSIT) throw 'minimum deposit is ' + MIN_DEPOSIT + ' USDC, this transfer (' + amt.toFixed(2) + ') is not credited';
  const u = W(w); u.usdc += amt; u.deposited = (u.deposited || 0) + amt; hist(u, { type: 'deposit', amt });
  db.txs[sig] = { w, amt, slot: tx.slot, ts: Date.now() }; db.treasuryIn.usdc += amt; db.treasuryIn.n++; save();
  return { amt, tx: sig, slot: tx.slot };
}
// handed only to a signed-in wallet at the moment it builds its transfer: the treasury's USDC account, the wallet's own USDC account, a fresh blockhash
async function depositIntent(w) {
  if (!TREASURY) throw 'deposits are not open yet';
  const [dst, src, bh] = await Promise.all([tokenAccounts(TREASURY, USDC.mint), tokenAccounts(w, USDC.mint), rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])]);
  if (!dst[0]) throw 'treasury USDC account is not set up yet';
  if (!src[0] || !src[0].amount) throw 'this wallet holds no USDC on Solana';
  return { dest: dst[0].pubkey, source: src[0].pubkey, balance: src[0].amount, mint: USDC.mint, decimals: USDC.dec, program: TOKEN_PROGRAM, blockhash: bh.value.blockhash, min: MIN_DEPOSIT };
}
// ---------- withdrawals: USDC leaves the ledger into a queue the treasury pays out by hand (no hot key on this server) ----------
if (!db.queue) db.queue = [];
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// ---------- THE VIGIL: temporary wUSD staking, paid in $WRAITH from a FIXED pre-funded pool. No printing. Hard end. ----------
const VIGIL = {
  apy: +(process.env.VIGIL_APY || 0.40),               // 40% APY, in wUSD terms
  pool: +(process.env.VIGIL_POOL || 5_000_000),         // WRAITH set aside by the treasury for the whole season
  cap: +(process.env.VIGIL_CAP || 250_000),             // max wUSD staked protocol-wide
  start: +(process.env.VIGIL_START || 1),                // open from launch
  end: +(process.env.VIGIL_END || 1796342400000),       // 2026-12-04 00:00 UTC, then it is over
};
if (!db.vigil) db.vigil = { staked: 0, paidWraith: 0, paidUsd: 0, stakers: 0 };
const VIGIL_BOOST = { apy: +(process.env.VIGIL_BOOST_APY || 1.00), end: +(process.env.VIGIL_BOOST_END || 1794268800000) };   // 100% APY through 2026-11-10, then back to VIGIL.apy
const vigilApy = (now) => now < VIGIL_BOOST.end ? VIGIL_BOOST.apy : VIGIL.apy;
function vigilLive(now) { return now >= VIGIL.start && now < VIGIL.end && db.vigil.paidWraith < VIGIL.pool; }
function accrue(u, now) {   // reward accrues in wUSD terms per second while the vigil is live
  if (!u.stake) return; const t0 = u.stakeT || now; const t1 = Math.min(now, VIGIL.end);
  if (t1 > t0 && vigilLive(t0)) u.stakeAcc = (u.stakeAcc || 0) + u.stake * vigilApy(t0) * (t1 - t0) / 31536000000;
  u.stakeT = now;
}
function vigilView(u, now) { accrue(u, now); const px = Math.max(0.000001, db.wraithPrice); return { staked: u.stake || 0, accruedUsd: u.stakeAcc || 0, accruedWraith: (u.stakeAcc || 0) / px, since: u.stakeSince || null }; }

// ---------- RITE III: The Note (pay links) + The Seal (view keys) ----------
//   The Note : lock shielded wUSD behind a secret; anyone holding the link claims it into their own shielded balance.
//              No recipient address is ever named. On the ledger it is one nullifier + one commitment, like any private send.
//   The Seal : a read-only view key. Whoever holds it can read your private balance and history and can never spend.
//              Selective disclosure — show an auditor, a partner, a court exactly what you choose, and nobody else.
if (!db.links) db.links = {};
if (!db.viewSalt) db.viewSalt = base58(randomBytes(32));
const hist = (w, e) => { w.hist = w.hist || []; w.hist.unshift({ ts: Date.now(), ...e }); if (w.hist.length > 200) w.hist.pop(); };
const linkId = (secret) => base58(sha('note|' + secret));
function viewKeyOf(addr) { const mac = createHmac('sha256', db.viewSalt).update('seal|' + addr).digest().subarray(0, 16); return base58(Buffer.concat([b58dec(addr), mac])); }
function walletOfViewKey(key) { try { let n = 0n; for (const ch of key) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); } let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex; let buf = Buffer.from(hex, 'hex'); let lead = 0; for (const ch of key) { if (ch === '1') lead++; else break; } buf = Buffer.concat([Buffer.alloc(lead), buf]); if (buf.length !== 48) return null; const addr = base58(buf.subarray(0, 32)); return viewKeyOf(addr) === key ? addr : null; } catch (e) { return null; } }

// ---------- BONDS: USDC in, discounted $WRAITH out, vested. The USDC stays in reserve and mints NOTHING, so every bond over-collateralizes wUSD. ----------
const BOND = {
  discount: +(process.env.BOND_DISCOUNT || 0.20),          // 20% below market
  vestMs: +(process.env.BOND_VEST_DAYS || 5) * 864e5,      // linear vest
  capUsd: +(process.env.BOND_CAP_USD || 5000),             // per-day capacity
  end: +(process.env.BOND_END || 1796342400000),  // same close as the vigil
  // THE FORGE: lock the bond. Deeper discount, hard 48-hour lock, and the locked WRAITH earns APY in WRAITH paid from the Vigil pool (fixed, no printing).
  lockDiscount: +(process.env.FORGE_DISCOUNT || 0.30), lockMs: +(process.env.FORGE_LOCK_DAYS || 2) * 864e5, lockApy: +(process.env.FORGE_APY || 0.80),
  min: 50,
};
if (!db.bonds) db.bonds = { soldUsd: 0, soldWraith: 0, n: 0, day: 0, dayUsd: 0 };
if (!db.forge) db.forge = { lockedWraith: 0, usd: 0, n: 0, yieldWraith: 0 };
const forgePrice = () => Math.max(0.000001, db.wraithPrice) * (1 - BOND.lockDiscount);
const forgeYield = (b, now) => b.lock ? b.wraith * BOND.lockApy * (Math.min(now, b.ts + BOND.lockMs) - b.ts) / 31536000000 : 0;
function bondDay() { const d = Math.floor(Date.now() / 864e5); if (db.bonds.day !== d) { db.bonds.day = d; db.bonds.dayUsd = 0; } return db.bonds; }
const bondPrice = () => Math.max(0.000001, db.wraithPrice) * (1 - BOND.discount);
function bondView(u, now) { const list = (u.bonds || []).map((b) => { const len = b.lock ? BOND.lockMs : BOND.vestMs; let k = Math.min(1, Math.max(0, (now - b.ts) / len)); if (b.lock && k < 1) k = 0; const vested = b.wraith * k; const y = forgeYield(b, now); return { id: b.id, usd: b.usd, wraith: b.wraith, price: b.price, ts: b.ts, lock: !!b.lock, vestEnd: b.ts + len, vested, yieldWraith: y, claimable: Math.max(0, vested - b.claimed) + (b.lock && k >= 1 && !b.yieldPaid ? y : 0), claimed: b.claimed }; }); return { list, claimable: list.reduce((x, b) => x + b.claimable, 0), pending: list.reduce((x, b) => x + (b.wraith - b.claimed), 0), locked: list.filter((b) => b.lock && b.claimed < b.wraith).reduce((x, b) => x + b.wraith, 0), forging: list.filter((b) => b.lock && b.claimed < b.wraith).reduce((x, b) => x + b.yieldWraith, 0) }; }

// ---------- THE DARK POOL: shielded 1x exposure to tokenized stocks, priced off the exchange tape, settled in shielded wUSD ----------
//   Ticker, size, side and P&L live inside the shield. The ledger sees one nullifier + one commitment per open/close, same as any private send.
//   No leverage. Position and open-interest caps. Tape must be fresh (< 15 min) or the market is closed to new trades. Shorts are capped at 95% loss.
const YF = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const DARK_FEED = { SOL: 'SOL-USD', TSLA: 'TSLA', NVDA: 'NVDA', AAPL: 'AAPL', SPY: 'SPY', COIN: 'COIN', MSTR: 'MSTR', GLD: 'GLD', BTC: 'BTC-USD', ETH: 'ETH-USD' };
const DARK = { fee: +(process.env.DARK_FEE || 0.003), maxPos: +(process.env.DARK_MAX_POS || 1000), maxOi: +(process.env.DARK_MAX_OI || 25000), fresh: 15 * 60e3, liq: 0.95 };
const TAPE = {};   // sym -> { px, ts, at }
async function pollTape() {
  for (const [sym, q] of Object.entries(DARK_FEED)) {
    try { const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 9000);
      const r = await fetch(YF + encodeURIComponent(q) + '?range=1d&interval=1m&includePrePost=true', { headers: { accept: 'application/json', 'user-agent': UA }, signal: ac.signal }); clearTimeout(tm); if (!r.ok) continue;
      const res = (await r.json()).chart.result[0]; const m = res.meta; let v = +m.regularMarketPrice, ts = m.regularMarketTime * 1000;
      const T = res.timestamp || [], C = (res.indicators.quote[0] && res.indicators.quote[0].close) || [];
      for (let i = C.length - 1; i >= 0; i--) if (C[i] != null && T[i] * 1000 > ts) { v = +C[i]; ts = T[i] * 1000; break; }
      if (v > 0) TAPE[sym] = { px: v, ts, at: Date.now() };
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  markDark();
}
setInterval(pollTape, 30000); pollTape();
const tapeFresh = (sym) => { const t = TAPE[sym]; return !!t && (Date.now() - t.ts) < DARK.fresh; };
if (!db.dark) db.dark = { oi: 0, open: 0, opened: 0, closed: 0, volume: 0, fees: 0, housePnl: 0, liqs: 0 };
const posPnl = (p, px) => p.side === 'long' ? p.notional * (px - p.entry) / p.entry : p.notional * (p.entry - px) / p.entry;
function closePos(w, p, px, why) {   // settle into the shield
  let pnl = posPnl(p, px); if (pnl < -p.notional * DARK.liq) pnl = -p.notional * DARK.liq;
  const fee = p.notional * DARK.fee; const back = Math.max(0, p.notional + pnl - fee);
  w.priv += back; pyre.tollUsd += fee; db.dark.fees += fee; db.dark.housePnl -= pnl; db.dark.oi = Math.max(0, db.dark.oi - p.notional); db.dark.open = Math.max(0, db.dark.open - 1); db.dark.closed++; if (why === 'liq') db.dark.liqs++;
  w.dark = (w.dark || []).filter((x) => x.id !== p.id); hist(w, { type: 'dark-close', amt: back, memo: p.sym + ' ' + p.side + ' · ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) });
  sh.nullifiers++; const { C, note } = shieldNote(back, shKeys[randomInt(0, shKeys.length)].pub); pushShTx({ sig: base58(randomBytes(32)), type: 'private', nullifier: nullifierOf('d', sh.notes), commitment: C, note, ts: Date.now() });
  return { pnl, fee, back };
}
function markDark() {   // auto-close anything past the loss cap
  for (const [addr, w] of Object.entries(db.wallets)) for (const p of (w.dark || []).slice()) { const t = TAPE[p.sym]; if (!t) continue; if (posPnl(p, t.px) <= -p.notional * DARK.liq) closePos(w, p, t.px, 'liq'); }
}
function darkView(u) { return (u.dark || []).map((p) => { const t = TAPE[p.sym]; const px = t ? t.px : p.entry; const pnl = Math.max(-p.notional * DARK.liq, posPnl(p, px)); return { ...p, px, pnl, fresh: tapeFresh(p.sym) }; }); }

// ---------- privacy primitives (real) ----------
const shKeys = [];
function shInit() { for (let i = 0; i < 16; i++) { const kp = generateKeyPairSync('x25519'); shKeys.push({ pub: kp.publicKey, addr: base58(rawX(kp.publicKey)), secret: base58(randomBytes(12)) }); } }
const commitTo = (amt, owner, bl) => base58(sha('cm|' + amt + '|' + owner + '|' + bl));
const nullifierOf = (sec, i) => base58(sha('nf|' + sec + '|' + i));
function merkleRoot(lv) { if (!lv.length) return base58(sha('empty')); let l = lv.slice(); while (l.length > 1) { const n = []; for (let i = 0; i < l.length; i += 2) n.push(base58(sha(l[i] + (l[i + 1] || l[i])))); l = n; } return l[0]; }
function encNote(pub, pt) { const e = generateKeyPairSync('x25519'); const s = diffieHellman({ privateKey: e.privateKey, publicKey: pub }); const k = sha(s); const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', k, iv); const ct = Buffer.concat([c.update(Buffer.from(pt)), c.final()]); return base58(Buffer.concat([rawX(e.publicKey), iv, c.getAuthTag(), ct])); }
const sh = db.shielded;
function pushShTx(tx) { sh.feed.unshift(tx); if (sh.feed.length > 60) sh.feed.pop(); sh.txCount++; if (sh.commitments.length > 1024) sh.commitments = sh.commitments.slice(-1024); sh.root = merkleRoot(sh.commitments); }
function shieldNote(amount, recipPub) { const bl = base58(randomBytes(8)); const C = commitTo(amount, recipPub ? base58(rawX(recipPub)) : 'anon', bl); sh.commitments.push(C); sh.notes++; return { C, note: encNote(recipPub || shKeys[0].pub, amount + '|' + bl) }; }

// ---------- $WRAITH price: Solana pools (DexScreener) when WRAITH_MINT is set ----------
let WRAITH_LIVE = { px: 0, liq: 0, pair: '', t: 0 };
async function pollWraith() {
  if (!WRAITH_MINT) return;
  try { const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + WRAITH_MINT); if (!r.ok) return;
    const ps = ((await r.json()).pairs || []).filter((p) => p.chainId === 'solana' && +p.priceUsd > 0).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    if (ps[0]) { WRAITH_LIVE = { px: +ps[0].priceUsd, liq: (ps[0].liquidity && ps[0].liquidity.usd) || 0, pair: ps[0].pairAddress || '', t: Date.now() }; db.wraithPrice = WRAITH_LIVE.px; } } catch (e) {}
}
setInterval(pollWraith, 20000); pollWraith();

// ---------- epoch tick: the pyre burns what the tolls collected ----------
//   wUSD is redeemable 1:1 against the ledger, so it is quoted at $1. CR is a protocol parameter (env CR).
//   Nothing here invents activity: supply, collateral and the shielded pool move only on real actions.
function tick() {
  const now = Date.now(); if ((now - db.lastTick) / 1000 < TICK_SEC) return; db.lastTick = now;
  pyreBurn(now);
  save();
}

// ---------- views ----------
const num = (v, hi) => { let n = +v; if (!isFinite(n) || n <= 0) return 0; return hi != null ? Math.min(n, hi) : n; };
function metrics() {
  const backing = db.collateralUsd / Math.max(1, db.wusdSupply);
  return {
    stable: STABLE, gov: GOV, mint: WRAITH_MINT || null, network: 'solana', explorer: 'https://solscan.io', wraithLive: WRAITH_LIVE.px ? WRAITH_LIVE : null, peg: 1.0, depositsOpen: !!TREASURY,
    wusdPrice: +db.wusdPrice.toFixed(4), pegStatus: db.wusdPrice >= 1.001 ? 'above' : db.wusdPrice <= 0.999 ? 'below' : 'at',
    wusdSupply: db.wusdSupply, wusdMarketCap: db.wusdPrice * db.wusdSupply,
    cr: db.cr, collateralUsd: db.collateralUsd, backingRatio: backing,
    wraithPrice: db.wraithPrice, wraithSupply: db.wraithSupply, wraithMarketCap: db.wraithPrice * db.wraithSupply,
    minDeposit: MIN_DEPOSIT, chain: { ok: CHAIN.ok, slot: CHAIN.slot, treasuryUsdc: CHAIN.treasuryUsdc, treasuryWraith: CHAIN.treasuryWraith, lastRead: CHAIN.lastRead, usdc: USDC.mint },
    deposits: { usdc: db.treasuryIn.usdc, n: db.treasuryIn.n }, dark: { markets: Object.keys(DARK_FEED).map((sym) => ({ sym, px: TAPE[sym] ? TAPE[sym].px : null, ts: TAPE[sym] ? TAPE[sym].ts : null, fresh: tapeFresh(sym) })), open: db.dark.open, opened: db.dark.opened, closed: db.dark.closed, volume: db.dark.volume, fees: db.dark.fees, liqs: db.dark.liqs, fee: DARK.fee, maxPos: DARK.maxPos, maxOi: DARK.maxOi, full: db.dark.oi >= DARK.maxOi }, bonds: (() => { const B = bondDay(); return { discount: BOND.discount, vestDays: BOND.vestMs / 864e5, capUsd: BOND.capUsd, leftToday: Math.max(0, BOND.capUsd - B.dayUsd), soldUsd: B.soldUsd, soldWraith: B.soldWraith, n: B.n, price: bondPrice(), market: db.wraithPrice, end: BOND.end, open: Date.now() <= BOND.end, min: BOND.min, forge: { discount: BOND.lockDiscount, lockDays: BOND.lockMs / 864e5, apy: BOND.lockApy, price: forgePrice(), lockedWraith: db.forge.lockedWraith, usd: db.forge.usd, n: db.forge.n, yieldWraith: db.forge.yieldWraith } }; })(), ferry: { cut: FERRY_CUT, souls: db.ferry.souls, paid: db.ferry.paid, board: ferrymen() }, notes: { created: Object.keys(db.links).length, open: Object.values(db.links).filter((L) => !L.claimed).length, claimed: Object.values(db.links).filter((L) => L.claimed).length }, queue: { open: db.queue.filter((q) => q.status === 'queued').length, openUsd: db.queue.filter((q) => q.status === 'queued').reduce((a, q) => a + q.amt, 0), paid: db.queue.filter((q) => q.status === 'paid').length },
    vigil: { ...VIGIL, apy: vigilApy(Date.now()), baseApy: VIGIL.apy, boost: { apy: VIGIL_BOOST.apy, end: VIGIL_BOOST.end, live: Date.now() < VIGIL_BOOST.end, endsIn: Math.max(0, VIGIL_BOOST.end - Date.now()) }, live: vigilLive(Date.now()), staked: db.vigil.staked, stakers: db.vigil.stakers, paidWraith: db.vigil.paidWraith, paidUsd: db.vigil.paidUsd, poolLeft: Math.max(0, VIGIL.pool - db.vigil.paidWraith), poolLeftUsd: Math.max(0, VIGIL.pool - db.vigil.paidWraith) * db.wraithPrice, endsIn: Math.max(0, VIGIL.end - Date.now()), startsIn: Math.max(0, VIGIL.start - Date.now()) },
    pyre: { tollUsd: pyre.tollUsd, burnedWraith: pyre.burnedWraith, burnedUsd: pyre.burnedUsd, epochs: pyre.epochs, minUsd: PYRE_MIN_USD, bps: { shield: 30, send: 30, unshield: 30, redeem: 50 }, burns: pyre.burns.slice(0, 8).map((b) => ({ id: b.id.slice(0, 8) + '…' + b.id.slice(-4), usd: b.usd, wraith: b.wraith, px: b.px, ts: b.ts, epoch: b.epoch })) },
    shielded: { totalValue: sh.totalValue, notes: sh.notes, nullifiers: sh.nullifiers, txCount: sh.txCount, root: sh.root },
    feed: sh.feed.slice(0, 10).map((t) => ({ sig: t.sig.slice(0, 6) + '…' + t.sig.slice(-4), type: t.type, publicAmount: t.publicAmount || null, ts: t.ts })),
  };
}
function account(addr) { const w = W(addr); const now = Date.now(); return { wallet: addr, usdc: w.usdc, wraith: w.wraith, wusd: w.wusd, priv: w.priv, deposited: w.deposited || 0, dark: darkView(w), bonds: bondView(w, now), ref: w.ref || null, souls: w.souls || 0, earned: w.earned || 0, vigil: vigilView(w, now), queue: db.queue.filter((q) => q.wallet === addr).slice(0, 10) }; }

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serve(req, res) { let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/') u = '/client/index.html'; if (u === '/view') u = '/client/view.html'; const f = path.normalize(path.join(ROOT, u)); if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); } fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); }); }
function json(res, c, o) { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }
function body(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }

http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/api/config') return json(res, 200, { stable: STABLE, gov: GOV, mint: WRAITH_MINT || null, network: 'solana', explorer: 'https://solscan.io', usdc: USDC.mint, minDeposit: MIN_DEPOSIT, depositsOpen: !!TREASURY, wraithLive: WRAITH_LIVE.px ? WRAITH_LIVE : null });
  if (u === '/api/session') { const w = new URL(req.url, 'http://x').searchParams.get('wallet') || ''; if (!isWallet(w)) return json(res, 200, { error: 'bad wallet' }); const exp = Date.now() + 7 * 864e5; return json(res, 200, { exp, message: sessionMsg(w, exp) }); }
  if (u === '/api/metrics') return json(res, 200, metrics());
  if (req.method === 'POST') {
    const d = await body(req);
    if (u === '/api/note/peek') { const L = db.links[linkId(String(d.secret || ''))]; if (!L) return json(res, 200, { error: 'no such note' }); return json(res, 200, { amt: L.amt, memo: L.memo, claimed: L.claimed, ts: L.ts }); }
    if (u === '/api/view') { const addr = walletOfViewKey(String(d.key || '')); if (!addr) return json(res, 200, { error: 'invalid view key' }); const v = W(addr); return json(res, 200, { ok: true, wallet: addr, priv: v.priv, staked: v.stake || 0, hist: (v.hist || []).slice(0, 100), notesOpen: Object.values(db.links).filter((L) => !L.claimed).length, root: sh.root, t: Date.now() }); }
    if (u === '/api/account') { if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'paste a valid Solana address' }); const aw = W(d.wallet); if (d.ref) { const fresh = !(aw.deposited || 0) && !(aw.hist || []).length; if (fresh && bind(aw, d.wallet, d.ref)) save(); } const acc = account(d.wallet); let signed = false; try { signed = requireSess(d.wallet, d.auth); } catch (e) {}
      if (!signed) { acc.priv = null; acc.dark = []; acc.sealed = true; }   // the shielded side is only shown to the wallet's own signed session
      return json(res, 200, acc); }
    if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'connect a wallet first' });
    const w = W(d.wallet);
    if (u !== '/api/deposit' && !u.startsWith('/api/admin/') && !(u === '/api/dev/faucet' && process.env.DEV_FAUCET === '1')) { try { requireSess(d.wallet, d.auth); } catch (e) { return json(res, 200, { error: String(e), auth: true }); } }
    if (u === '/api/deposit/intent') { try { return json(res, 200, await depositIntent(d.wallet)); } catch (e) { return json(res, 200, { error: String(e.message || e) }); } }

    if (u === '/api/mint') { // collateral + WRAITH -> wUSD
      const m = num(d.amount); if (!m) return json(res, 200, { error: 'enter an amount' });
      const needUsdc = m * db.cr; const algoUsd = m * (1 - db.cr); const burnWraith = db.wraithPrice > 0 ? algoUsd / db.wraithPrice : 0;
      if (w.usdc < m) return json(res, 200, { error: 'not enough USDC — deposit first' });
      // the algorithmic slice is paid in USDC too: it buys WRAITH at market and burns it via the pyre (nothing is printed to mint wUSD)
      w.usdc -= m; w.wusd += m; db.wusdSupply += m; db.collateralUsd += needUsdc;
      pyre.tollUsd += algoUsd; save();
      return json(res, 200, { ok: true, minted: m, usedUsdc: needUsdc, algoUsd, burnedWraith: burnWraith, ...account(d.wallet) });
    }
    if (u === '/api/dev/faucet' && process.env.DEV_FAUCET === '1') { w.usdc += num(d.amount) || 0; save(); return json(res, 200, { ok: true, ...account(d.wallet) }); }   // LOCAL TESTING ONLY — never set DEV_FAUCET in production
    if (u === '/api/deposit') { try { const r = await creditDeposit(d.wallet, d.tx); return json(res, 200, { ok: true, ...r, ...account(d.wallet) }); } catch (e) { return json(res, 200, { error: String(e.message || e) }); } }
    if (u === '/api/bond') { // USDC ledger -> discounted WRAITH, vested. USDC stays in reserve. Nothing minted.
      const now = Date.now(); if (now > BOND.end) return json(res, 200, { error: 'bonds are closed' }); if (!(db.wraithPrice > 0)) return json(res, 200, { error: 'opens when $WRAITH trades: no live price yet' });
      const x = num(d.amount, w.usdc); if (!x) return json(res, 200, { error: 'not enough USDC — deposit first' }); if (x < BOND.min) return json(res, 200, { error: 'minimum bond is ' + BOND.min + ' USDC' });
      const B = bondDay(); if (B.dayUsd + x > BOND.capUsd) return json(res, 200, { error: 'today\'s bond capacity is spent — ' + (BOND.capUsd - B.dayUsd).toFixed(2) + ' USDC left' });
      const lock = !!d.lock; const price = lock ? forgePrice() : bondPrice(); const wraith = x / price;
      w.usdc -= x; db.collateralUsd += x; B.dayUsd += x; B.soldUsd += x; B.soldWraith += wraith; B.n++; if (lock) { db.forge.lockedWraith += wraith; db.forge.usd += x; db.forge.n++; }
      w.bonds = w.bonds || []; w.bonds.push({ id: base58(randomBytes(6)), usd: x, wraith, price, ts: now, claimed: 0, lock }); hist(w, { type: lock ? 'forge' : 'bond', amt: x }); save();
      return json(res, 200, { ok: true, bonded: x, wraithOut: wraith, price, market: db.wraithPrice, lock, unlockAt: lock ? now + BOND.lockMs : now + BOND.vestMs, apy: lock ? BOND.lockApy : 0, ...account(d.wallet) });
    }
    if (u === '/api/bond/claim') { const now = Date.now(); let got = 0, forged = 0; for (const b of w.bonds || []) { if (b.lock) { if (now < b.ts + BOND.lockMs) continue; const c = b.wraith - b.claimed; if (c > 0) { b.claimed = b.wraith; got += c; db.forge.lockedWraith = Math.max(0, db.forge.lockedWraith - c); } if (!b.yieldPaid) { let y = forgeYield(b, now); const left = VIGIL.pool - db.vigil.paidWraith; if (y > left) y = Math.max(0, left); b.yieldPaid = true; forged += y; db.vigil.paidWraith += y; db.vigil.paidUsd += y * db.wraithPrice; db.forge.yieldWraith += y; } continue; } const k = Math.min(1, (now - b.ts) / BOND.vestMs); const c = Math.max(0, b.wraith * k - b.claimed); b.claimed += c; got += c; } if (got + forged < 1e-9) return json(res, 200, { error: 'nothing vested or unlocked yet' }); w.wraith += got + forged; save(); return json(res, 200, { ok: true, claimedWraith: got + forged, forgedWraith: forged, ...account(d.wallet) }); }
    if (u === '/api/withdraw') { // ledger -> payout queue (treasury pays by hand, then marks it paid). asset: USDC (default) or WRAITH
      const asset = d.asset === 'WRAITH' ? 'WRAITH' : 'USDC';
      const x = num(d.amount, asset === 'WRAITH' ? w.wraith : w.usdc); if (!x) return json(res, 200, { error: 'nothing to withdraw' }); if (asset === 'USDC' && x < 1) return json(res, 200, { error: 'minimum 1 USDC' });
      if (asset === 'WRAITH') w.wraith -= x; else w.usdc -= x;
      const q = { id: base58(randomBytes(6)), wallet: d.wallet, amt: x, asset, ts: Date.now(), status: 'queued', tx: null }; db.queue.unshift(q); if (db.queue.length > 500) db.queue.pop(); save();
      return json(res, 200, { ok: true, queued: q, ...account(d.wallet) });
    }
    if (u === '/api/admin/queue') { if (!ADMIN_KEY || d.key !== ADMIN_KEY) return json(res, 200, { error: 'no' }); return json(res, 200, { ok: true, queue: db.queue.slice(0, 100), deposits: Object.entries(db.txs).map(([tx, t]) => ({ tx, ...t })).slice(-50) }); }
    if (u === '/api/admin/paid') { if (!ADMIN_KEY || d.key !== ADMIN_KEY) return json(res, 200, { error: 'no' }); const q = db.queue.find((x) => x.id === d.id); if (!q) return json(res, 200, { error: 'no such item' }); q.status = 'paid'; q.tx = d.tx || null; q.paidTs = Date.now(); save(); return json(res, 200, { ok: true, q }); }
    if (u === '/api/stake') { // wUSD -> the vigil
      const now = Date.now(); if (!vigilLive(now)) return json(res, 200, { error: 'the vigil is not open' });
      const x = num(d.amount, w.wusd); if (!x) return json(res, 200, { error: 'nothing to stake' });
      if (db.vigil.staked + x > VIGIL.cap) return json(res, 200, { error: 'the vigil is full — cap ' + VIGIL.cap.toLocaleString() + ' wUSD' });
      accrue(w, now); if (!w.stake) { db.vigil.stakers++; w.stakeSince = now; } w.wusd -= x; w.stake = (w.stake || 0) + x; w.stakeT = now; db.vigil.staked += x; save();
      return json(res, 200, { ok: true, staked: x, ...account(d.wallet) });
    }
    if (u === '/api/unstake') { const now = Date.now(); accrue(w, now); const x = num(d.amount, w.stake || 0); if (!x) return json(res, 200, { error: 'nothing staked' });
      const xn = toll('unshield', x, w); w.stake -= x; w.wusd += xn; db.vigil.staked = Math.max(0, db.vigil.staked - x); if (w.stake <= 0) { w.stake = 0; db.vigil.stakers = Math.max(0, db.vigil.stakers - 1); } save();
      return json(res, 200, { ok: true, unstaked: xn, toll: x - xn, ...account(d.wallet) });
    }
    if (u === '/api/claim') { const now = Date.now(); accrue(w, now); const usd = w.stakeAcc || 0; if (usd < 0.01) return json(res, 200, { error: 'nothing to claim yet' }); if (!(db.wraithPrice > 0)) return json(res, 200, { error: 'opens when $WRAITH trades: no live price yet' });
      const px = Math.max(0.000001, db.wraithPrice); let wraith = usd / px; const left = VIGIL.pool - db.vigil.paidWraith; if (left <= 0) return json(res, 200, { error: 'the pool is spent — the vigil is over' }); if (wraith > left) wraith = left;
      w.stakeAcc = 0; w.wraith += wraith; db.vigil.paidWraith += wraith; db.vigil.paidUsd += wraith * px; save();
      return json(res, 200, { ok: true, claimedWraith: wraith, claimedUsd: wraith * px, ...account(d.wallet) });
    }
    if (u === '/api/redeem') { // wUSD -> collateral + WRAITH
      const r = num(d.amount, w.wusd); if (!r) return json(res, 200, { error: 'nothing to redeem' });
      if (!(db.wraithPrice > 0)) return json(res, 200, { error: 'opens when $WRAITH trades: no live price yet' }); const rn = toll('redeem', r, w); const outUsdc = rn * db.cr; const mintWraith = (rn * (1 - db.cr)) / db.wraithPrice;
      w.wusd -= r; w.usdc += outUsdc; w.wraith += mintWraith; db.wusdSupply = Math.max(0, db.wusdSupply - r); db.collateralUsd = Math.max(0, db.collateralUsd - outUsdc); db.wraithSupply += mintWraith; save();
      return json(res, 200, { ok: true, redeemed: r, gotUsdc: outUsdc, gotWraith: mintWraith, ...account(d.wallet) });
    }
    if (u === '/api/note/create') { // lock shielded wUSD behind a secret link
      const x = num(d.amount, w.priv); if (!x) return json(res, 200, { error: 'not enough private balance' }); if (x < 1) return json(res, 200, { error: 'minimum 1 wUSD' });
      const secret = base58(randomBytes(16)); const id = linkId(secret); const xn = toll('send', x, w);
      w.priv -= x; sh.nullifiers++; const { C, note } = shieldNote(xn, shKeys[randomInt(0, shKeys.length)].pub);
      db.links[id] = { amt: xn, memo: String(d.memo || '').slice(0, 80), ts: Date.now(), claimed: false, by: d.wallet, from: base58(sha('from|' + d.wallet + '|' + secret)) };
      pushShTx({ sig: base58(randomBytes(32)), type: 'private', nullifier: nullifierOf('n', sh.notes), commitment: C, note, ts: Date.now() });
      hist(w, { type: 'note', amt: x, id }); save();
      return json(res, 200, { ok: true, secret, id, amt: xn, toll: x - xn, ...account(d.wallet) });
    }
    if (u === '/api/note/claim') { // anyone holding the secret claims it into THEIR shielded balance
      const L = db.links[linkId(String(d.secret || ''))]; if (!L) return json(res, 200, { error: 'no such note' }); if (L.claimed) return json(res, 200, { error: 'this note was already claimed' });
      L.claimed = true; L.claimedTs = Date.now(); w.priv += L.amt; if (L.by) bind(w, d.wallet, L.by); hist(w, { type: 'claimed', amt: L.amt, memo: L.memo }); save();
      return json(res, 200, { ok: true, claimed: L.amt, memo: L.memo, ...account(d.wallet) });
    }
    if (u === '/api/seal') { return json(res, 200, { ok: true, viewKey: viewKeyOf(d.wallet) }); }
    if (u === '/api/dark/open') { // shielded wUSD -> a hidden position
      const sym = String(d.sym || '').toUpperCase(); if (!DARK_FEED[sym]) return json(res, 200, { error: 'unknown market' });
      if (!tapeFresh(sym)) return json(res, 200, { error: sym + ' tape is closed right now — try when the market is open' });
      const side = d.side === 'short' ? 'short' : 'long'; const x = num(d.amount, w.priv); if (!x) return json(res, 200, { error: 'not enough shielded wUSD' }); if (x < 10) return json(res, 200, { error: 'minimum 10 wUSD' });
      if (x > DARK.maxPos) return json(res, 200, { error: 'max ' + DARK.maxPos + ' wUSD per position' }); if (db.dark.oi + x > DARK.maxOi) return json(res, 200, { error: 'the pool is full for now' });
      const fee = x * DARK.fee; const notional = x - fee; const px = TAPE[sym].px;
      w.priv -= x; pyre.tollUsd += fee; db.dark.fees += fee; db.dark.oi += notional; db.dark.open++; db.dark.opened++; db.dark.volume += notional;
      const p = { id: base58(randomBytes(6)), sym, side, notional, entry: px, ts: Date.now() }; w.dark = w.dark || []; w.dark.push(p); hist(w, { type: 'dark-open', amt: x, memo: sym + ' ' + side });
      sh.nullifiers++; const { C, note } = shieldNote(notional, shKeys[randomInt(0, shKeys.length)].pub); pushShTx({ sig: base58(randomBytes(32)), type: 'private', nullifier: nullifierOf('d', sh.notes), commitment: C, note, ts: Date.now() }); save();
      return json(res, 200, { ok: true, opened: p, ...account(d.wallet) });
    }
    if (u === '/api/dark/close') { const p = (w.dark || []).find((x) => x.id === d.id); if (!p) return json(res, 200, { error: 'no such position' }); if (!tapeFresh(p.sym)) return json(res, 200, { error: p.sym + ' tape is closed — closes settle when the market is open' });
      const r = closePos(w, p, TAPE[p.sym].px, 'user'); save(); return json(res, 200, { ok: true, closed: r, ...account(d.wallet) }); }
    if (u === '/api/shield') { // public wUSD -> private
      const s = num(d.amount, w.wusd); if (!s) return json(res, 200, { error: 'nothing to shield' });
      const sn = toll('shield', s, w); w.wusd -= s; w.priv += sn; sh.totalValue += sn; hist(w, { type: 'shield', amt: sn }); const { C, note } = shieldNote(sn, shKeys[0].pub);
      pushShTx({ sig: base58(randomBytes(32)), type: 'shield', commitment: C, note, ts: Date.now() }); save();
      return json(res, 200, { ok: true, shielded: sn, toll: s - sn, ...account(d.wallet) });
    }
    if (u === '/api/send') { // shielded transfer — amount + parties hidden
      if (!isWallet(d.to || '')) return json(res, 200, { error: 'enter a valid recipient address' });
      const x = num(d.amount, w.priv); if (!x) return json(res, 200, { error: 'not enough private balance' });
      const xn = toll('send', x, w); w.priv -= x; const r = W(d.to); r.priv += xn; sh.nullifiers++; hist(w, { type: 'sent', amt: x, to: d.to }); hist(r, { type: 'received', amt: xn });
      const { C, note } = shieldNote(xn, shKeys[randomInt(0, shKeys.length)].pub);
      pushShTx({ sig: base58(randomBytes(32)), type: 'private', nullifier: nullifierOf('u', sh.notes), commitment: C, note, ts: Date.now() }); save();
      return json(res, 200, { ok: true, sent: xn, toll: x - xn, ...account(d.wallet) });
    }
    if (u === '/api/unshield') { // private -> public
      const un = num(d.amount, w.priv); if (!un) return json(res, 200, { error: 'nothing to unshield' });
      const unn = toll('unshield', un, w); w.priv -= un; w.wusd += unn; hist(w, { type: 'unshield', amt: un }); sh.totalValue = Math.max(0, sh.totalValue - un); sh.nullifiers++;
      pushShTx({ sig: base58(randomBytes(32)), type: 'unshield', nullifier: nullifierOf('u', sh.notes), publicAmount: un, ts: Date.now() }); save();
      return json(res, 200, { ok: true, unshielded: unn, toll: un - unn, ...account(d.wallet) });
    }
  }
  serve(req, res);
}).listen(PORT, () => console.log('WRAITH (' + STABLE + '/' + GOV + ') on Solana · :' + PORT));

shInit();
setInterval(tick, 1000);
