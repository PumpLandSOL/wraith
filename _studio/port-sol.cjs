// One-time port of the STYX engine (Robinhood Chain) to WRAITH on Solana. Run from wraith/: node _studio/port-sol.cjs
const fs = require('fs'), p = 'server/index.js'; let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('nomatch: ' + a.slice(0, 80)); s = s.split(a).join(b); };

rep(s.slice(0, s.indexOf("'use strict';")), `// WRAITH: a private, fractional-algorithmic stablecoin on Solana.
//   wUSD    : the stablecoin, $1, backed by real USDC deposits (Frax-style fractional: the collateral slice stays in reserve,
//             the algorithmic slice buys $WRAITH at market and burns it)
//   $WRAITH : the share token (SPL, Solana)
//   Privacy : shield wUSD -> hold a private balance -> send shielded (amount + parties hidden).
// Every balance moves only on a real event: a USDC deposit verified on Solana, or an action signed by the wallet's own key.
// Dependency-free.
`);
rep(`const PORT = process.env.PORT || 8198;`, `const PORT = process.env.PORT || 8270;`);
rep(`const WRAITH_MINT = process.env.WRAITH_MINT || '0xdbd2bd1a734d2b3dc8f88bacc404810fcbff36c4';   // $WRAITH · Robinhood Chain · LIVE
const TREASURY = (process.env.TREASURY || '0x28FC1899eDD7973dc5A9c95321E0cdeB3d8419d1');            // $WRAITH on Robinhood Chain — CA bar lights when set`,
`const WRAITH_MINT = process.env.WRAITH_MINT || '';   // $WRAITH SPL mint: the CA bar, price feed and burns light up when set
const TREASURY = process.env.TREASURY || '';         // Solana wallet that receives USDC. Environment only: never in the repo, never returned by an API.`);

// state starts at zero and moves only on real events
rep(`  wusdPrice: 1.0, wusdSupply: 1_250_000, wraithPrice: 0.85, wraithSupply: 100_000_000,
  cr: 0.9,                       // collateral ratio (fractional-algorithmic)
  collateralUsd: 1_125_000,      // ETH+USDC reserves backing wUSD`,
`  wusdPrice: 1.0, wusdSupply: 0, wraithPrice: 0, wraithSupply: 1_000_000_000,
  cr: +(process.env.CR || 0.9),  // collateral ratio: share of every mint kept as USDC in reserve
  collateralUsd: 0,              // USDC in reserve backing wUSD`);
rep(`if (db.v !== 2) { db.wallets = {}; db.v = 2; }   // v2: real deposits only — the seeded paper ledger is wiped`,
`if (db.v !== 1) { db = { ...db, v: 1, wallets: {}, wusdSupply: 0, collateralUsd: 0 }; }   // Solana ledger v1`);

// wallets: Solana base58, case-sensitive; sessions signed with Phantom
rep(`function bind(w, addr, refAddr) { refAddr = (refAddr || '').toLowerCase();`, `function bind(w, addr, refAddr) { refAddr = refAddr || '';`);
rep(`const isWallet = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);
function W(a) { a = a.toLowerCase(); return`,
`function b58dec(str) { let n = 0n; for (const ch of str) { const i = B58.indexOf(ch); if (i < 0) throw new Error('b58'); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const ch of str) { if (ch === '1') out.unshift(0); else break; } return Buffer.from(out); }
const isWallet = (s) => { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '')) return false; try { return b58dec(s).length === 32; } catch (e) { return false; } };
// ---------- sessions: every action that moves value is signed by the wallet (Phantom signMessage, ed25519) ----------
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const SESSIONS = new Map();
const sessionMsg = (w, exp) => ['WRAITH session', 'Wallet: ' + w, 'Expires: ' + exp, 'Signing is free and moves no funds.'].join('\\n');
function requireSess(w, auth) {
  if (!auth || !auth.sig || !auth.exp) throw 'sign in with your wallet first';
  const exp = +auth.exp; if (!(exp > Date.now())) throw 'session expired, sign in again'; if (exp > Date.now() + 8 * 864e5) throw 'bad session';
  const key = w + ':' + exp + ':' + auth.sig; if (SESSIONS.get(key)) return true;
  let ok = false; try { const pk = b58dec(w), sig = b58dec(auth.sig); if (pk.length !== 32 || sig.length !== 64) throw 0;
    ok = require('crypto').verify(null, Buffer.from(sessionMsg(w, exp), 'utf8'), require('crypto').createPublicKey({ key: Buffer.concat([SPKI_ED25519, pk]), format: 'der', type: 'spki' }), sig); } catch (e) { throw 'bad signature'; }
  if (!ok) throw 'signature is not from this wallet';
  if (SESSIONS.size > 5000) SESSIONS.clear(); SESSIONS.set(key, 1); return true;
}
function W(a) { return`);

// chain: USDC (SPL) deposits on Solana
const c0 = s.indexOf('// ---------- chain: real USDC deposits'), c1 = s.indexOf('// ---------- withdrawals:');
s = s.slice(0, c0) + `// ---------- chain: real USDC (SPL) deposits to TREASURY, verified on Solana ----------
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
` + s.slice(c1);

// campaign windows: fresh season from launch
rep(`start: +(process.env.VIGIL_START || 1),                // OPEN NOW (2026-09-09)
  end: +(process.env.VIGIL_END || 1791676800000),       // 2026-10-11 00:00 UTC — 30 days, then it is over`,
`start: +(process.env.VIGIL_START || 1),                // open from launch
  end: +(process.env.VIGIL_END || 1796342400000),       // 2026-12-04 00:00 UTC, then it is over`);
rep(`VIGIL_BOOST_END || 1789603200000) };   // 100% APY through 2026-09-17, then back to VIGIL.apy`, `VIGIL_BOOST_END || 1794268800000) };   // 100% APY through 2026-11-10, then back to VIGIL.apy`);
rep(`end: +(process.env.BOND_END || 1791676800000),  // same close as the vigil`, `end: +(process.env.BOND_END || 1796342400000),  // same close as the vigil`);

// view keys carry the 32-byte Solana key
rep(`createHmac('sha256', db.viewSalt).update('seal|' + addr.toLowerCase()).digest().subarray(0, 16); return base58(Buffer.concat([Buffer.from(addr.slice(2), 'hex'), mac])); }`,
`createHmac('sha256', db.viewSalt).update('seal|' + addr).digest().subarray(0, 16); return base58(Buffer.concat([b58dec(addr), mac])); }`);
rep(`if (buf.length !== 36) return null; const addr = '0x' + buf.subarray(0, 20).toString('hex');`, `if (buf.length !== 48) return null; const addr = base58(buf.subarray(0, 32));`);

// dark pool: SOL instead of HOOD
rep(`const DARK_FEED = { HOOD: 'HOOD', `, `const DARK_FEED = { SOL: 'SOL-USD', `);

// price from Solana pools; nothing drifts
rep(`// ---------- $WRAITH price: Robinhood Chain pools (DexScreener) when WRAITH_MINT is set ----------`, `// ---------- $WRAITH price: Solana pools (DexScreener) when WRAITH_MINT is set ----------`);
rep(`p.chainId === 'robinhood'`, `p.chainId === 'solana'`);
const t0 = s.indexOf('// ---------- peg / algo tick ----------'), t1 = s.indexOf('// ---------- views ----------');
s = s.slice(0, t0) + `// ---------- epoch tick: the pyre burns what the tolls collected ----------
//   wUSD is redeemable 1:1 against the ledger, so it is quoted at $1. CR is a protocol parameter (env CR).
//   Nothing here invents activity: supply, collateral and the shielded pool move only on real actions.
function tick() {
  const now = Date.now(); if ((now - db.lastTick) / 1000 < TICK_SEC) return; db.lastTick = now;
  pyreBurn(now);
  save();
}

` + s.slice(t1);
rep(`function pyreBurn(now) {
  if (pyre.tollUsd < PYRE_MIN_USD) return;`, `function pyreBurn(now) {
  if (pyre.tollUsd < PYRE_MIN_USD || !(db.wraithPrice > 0)) return;   // burns wait for a live $WRAITH price`);
rep(`const simProof = () => base58(randomBytes(40));\n`, ``);
s = s.split(`, proof: simProof()`).join('');

// metrics + config: Solana, treasury never exposed
rep(`stable: STABLE, gov: GOV, mint: WRAITH_MINT, treasury: TREASURY, network: 'robinhood', chainId: 4663, explorer: 'https://explorer.mainnet.chain.robinhood.com', wraithLive: WRAITH_LIVE.px ? WRAITH_LIVE : null, peg: 1.0,`,
`stable: STABLE, gov: GOV, mint: WRAITH_MINT || null, network: 'solana', explorer: 'https://solscan.io', wraithLive: WRAITH_LIVE.px ? WRAITH_LIVE : null, peg: 1.0, depositsOpen: !!TREASURY,`);
rep(`if (u === '/api/config') return json(res, 200, { stable: STABLE, gov: GOV, mint: WRAITH_MINT, treasury: TREASURY, network: 'robinhood', chainId: 4663, explorer: 'https://explorer.mainnet.chain.robinhood.com', wraithLive: WRAITH_LIVE.px ? WRAITH_LIVE : null });`,
`if (u === '/api/config') return json(res, 200, { stable: STABLE, gov: GOV, mint: WRAITH_MINT || null, network: 'solana', explorer: 'https://solscan.io', usdc: USDC.mint, minDeposit: MIN_DEPOSIT, depositsOpen: !!TREASURY, wraithLive: WRAITH_LIVE.px ? WRAITH_LIVE : null });
  if (u === '/api/session') { const w = new URL(req.url, 'http://x').searchParams.get('wallet') || ''; if (!isWallet(w)) return json(res, 200, { error: 'bad wallet' }); const exp = Date.now() + 7 * 864e5; return json(res, 200, { exp, message: sessionMsg(w, exp) }); }`);
rep(`chain: { ok: CHAIN.ok, block: CHAIN.block, treasuryUsdc: CHAIN.treasuryUsdc, treasuryWraith: CHAIN.treasuryWraith, lastRead: CHAIN.lastRead, usdc: USDC.addr, rpc: RPCS[0] },`,
`chain: { ok: CHAIN.ok, slot: CHAIN.slot, treasuryUsdc: CHAIN.treasuryUsdc, treasuryWraith: CHAIN.treasuryWraith, lastRead: CHAIN.lastRead, usdc: USDC.mint },`);
rep(`queue: db.queue.filter((q) => q.wallet === addr.toLowerCase()).slice(0, 10)`, `queue: db.queue.filter((q) => q.wallet === addr).slice(0, 10)`);

// routes: Solana wording, no lowercasing, signed sessions on every value-moving action, intent endpoint
rep(`if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'paste a valid Robinhood Chain address' }); const aw = W(d.wallet); if (d.ref) { const fresh = !(aw.deposited || 0) && !(aw.hist || []).length; if (fresh && bind(aw, d.wallet.toLowerCase(), d.ref)) save(); }`,
`if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'paste a valid Solana address' }); const aw = W(d.wallet); if (d.ref) { const fresh = !(aw.deposited || 0) && !(aw.hist || []).length; if (fresh && bind(aw, d.wallet, d.ref)) save(); }`);
rep(`    if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'connect a wallet first' });
    const w = W(d.wallet);
`, `    if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'connect a wallet first' });
    const w = W(d.wallet);
    if (u !== '/api/deposit' && !u.startsWith('/api/admin/') && !(u === '/api/dev/faucet' && process.env.DEV_FAUCET === '1')) { try { requireSess(d.wallet, d.auth); } catch (e) { return json(res, 200, { error: String(e), auth: true }); } }
    if (u === '/api/deposit/intent') { try { return json(res, 200, await depositIntent(d.wallet)); } catch (e) { return json(res, 200, { error: String(e.message || e) }); } }
`);
rep(`creditDeposit(d.wallet.toLowerCase(), d.tx)`, `creditDeposit(d.wallet, d.tx)`);
s = s.split(`d.wallet.toLowerCase()`).join('d.wallet').split(`d.to.toLowerCase()`).join('d.to');
// mint: no direct supply cut at a made-up price; the algorithmic slice goes to the pyre, which burns at the live price
rep(`w.usdc -= m; w.wusd += m; db.wusdSupply += m; db.collateralUsd += needUsdc; db.wraithSupply = Math.max(0, db.wraithSupply - burnWraith);`, `w.usdc -= m; w.wusd += m; db.wusdSupply += m; db.collateralUsd += needUsdc;`);
rep(`const needUsdc = m * db.cr; const algoUsd = m * (1 - db.cr); const burnWraith = algoUsd / db.wraithPrice;`, `const needUsdc = m * db.cr; const algoUsd = m * (1 - db.cr); const burnWraith = db.wraithPrice > 0 ? algoUsd / db.wraithPrice : 0;`);
// everything priced in $WRAITH needs a live market price first
const NEEDPX = `if (!(db.wraithPrice > 0)) return json(res, 200, { error: 'opens when $WRAITH trades: no live price yet' });`;
rep(`const now = Date.now(); if (now > BOND.end) return json(res, 200, { error: 'bonds are closed' });`, `const now = Date.now(); if (now > BOND.end) return json(res, 200, { error: 'bonds are closed' }); ${NEEDPX}`);
rep(`if (usd < 0.01) return json(res, 200, { error: 'nothing to claim yet' });`, `if (usd < 0.01) return json(res, 200, { error: 'nothing to claim yet' }); ${NEEDPX}`);
rep(`const rn = toll('redeem', r, w); const outUsdc = rn * db.cr; const mintWraith = (rn * (1 - db.cr)) / db.wraithPrice;`, `${NEEDPX} const rn = toll('redeem', r, w); const outUsdc = rn * db.cr; const mintWraith = (rn * (1 - db.cr)) / db.wraithPrice;`);
rep(`console.log('WRAITH (' + STABLE + '/' + GOV + ') on Robinhood Chain · :' + PORT)`, `console.log('WRAITH (' + STABLE + '/' + GOV + ') on Solana · :' + PORT)`);
fs.writeFileSync(p, s); console.log('ported');
