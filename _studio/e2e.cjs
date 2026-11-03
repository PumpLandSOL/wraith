// WRAITH backend end-to-end: real ed25519 wallets, signed sessions, every ledger action.
//   node _studio/e2e.cjs            (boots its own server on :8271 with DEV_FAUCET=1 and a throwaway ledger)
const { spawn } = require('child_process'), crypto = require('crypto'), path = require('path'), os = require('os'), fs = require('fs');
const PORT = 8271, URL0 = 'http://127.0.0.1:' + PORT, DATA = path.join(os.tmpdir(), 'wraith-e2e-' + Date.now() + '.json');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => { let n = BigInt('0x' + Buffer.from(buf).toString('hex')), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of buf) { if (b === 0) s = '1' + s; else break; } return s; };
function wallet() { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12); return { addr: b58(raw), key: privateKey }; }
const post = (u, d) => fetch(URL0 + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) }).then((r) => r.json());
async function signIn(w) { const s = await fetch(URL0 + '/api/session?wallet=' + w.addr).then((r) => r.json()); w.auth = { exp: s.exp, sig: b58(crypto.sign(null, Buffer.from(s.message, 'utf8'), w.key)) }; }
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT, DATA_PATH: DATA, DEV_FAUCET: '1', TREASURY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(URL0 + '/api/config'); break; } catch (e) { await new Promise((r) => setTimeout(r, 150)); } }
  try {
    const A = wallet(), B = wallet(), act = (u, w, d) => post(u, { wallet: w.addr, auth: w.auth, ...d });
    const cfg = await fetch(URL0 + '/api/config').then((r) => r.json());
    ok(cfg.network === 'solana' && cfg.stable === 'wUSD' && cfg.gov === 'WRAITH' && !('treasury' in cfg), 'config: Solana, wUSD/$WRAITH, treasury never exposed');
    const m0 = await fetch(URL0 + '/api/metrics').then((r) => r.json());
    ok(m0.wusdSupply === 0 && m0.collateralUsd === 0 && m0.shielded.txCount === 0, 'metrics start at zero (nothing invented)');
    ok((await post('/api/account', { wallet: '0x28FC1899eDD7973dc5A9c95321E0cdeB3d8419d1' })).error, 'EVM address rejected');
    ok((await act('/api/mint', A, { amount: 10 })).auth, 'unsigned action refused');
    A.auth = { exp: Date.now() + 864e5, sig: b58(crypto.randomBytes(64)) };
    ok((await act('/api/mint', A, { amount: 10 })).auth, 'forged signature refused');
    await signIn(A); await signIn(B);
    ok((await act('/api/deposit/intent', A, {})).error === 'deposits are not open yet', 'deposit intent closed without TREASURY');
    ok((await post('/api/deposit', { wallet: A.addr, tx: 'x' })).error, 'bad deposit signature rejected');
    await post('/api/dev/faucet', { wallet: A.addr, amount: 1000 });
    const mt = await act('/api/mint', A, { amount: 500 });
    ok(mt.ok && mt.wusd === 500 && mt.usdc === 500 && Math.abs(mt.usedUsdc - 450) < 1e-9, 'mint 500 wUSD: 450 USDC to reserve, 50 to the pyre');
    const sd = await act('/api/shield', A, { amount: 400 });
    ok(sd.ok && Math.abs(sd.priv - 398.8) < 1e-6, 'shield 400 → 398.80 private (30 bps toll)');
    const pub = await post('/api/account', { wallet: A.addr });
    ok(pub.priv === null && pub.sealed, 'private balance hidden from an unsigned read');
    const own = await post('/api/account', { wallet: A.addr, auth: A.auth });
    ok(Math.abs(own.priv - 398.8) < 1e-6, 'owner sees their private balance with a signed session');
    const sn = await act('/api/send', A, { to: B.addr, amount: 100 });
    const bAcc = await post('/api/account', { wallet: B.addr, auth: B.auth });
    ok(sn.ok && Math.abs(bAcc.priv - 99.7) < 1e-6, 'shielded send 100 → B receives 99.70');
    const nt = await act('/api/note/create', A, { amount: 50, memo: 'rent' });
    const cl = await act('/api/note/claim', B, { secret: nt.secret });
    ok(nt.ok && cl.ok && Math.abs(cl.claimed - 49.85) < 1e-6, 'pay link: A locks 50, B claims 49.85');
    ok((await act('/api/note/claim', B, { secret: nt.secret })).error, 'pay link cannot be claimed twice');
    const seal = await act('/api/seal', A, {});
    const view = await post('/api/view', { key: seal.viewKey });
    ok(view.ok && view.wallet === A.addr && Math.abs(view.priv - own.priv + 150) < 1e-6, 'view key opens A\'s private ledger (read-only)');
    const us = await act('/api/unshield', A, { amount: 100 });
    ok(us.ok && Math.abs(us.unshielded - 99.7) < 1e-6, 'unshield 100 → 99.70 public wUSD');
    ok((await act('/api/bond', A, { amount: 100 })).error.includes('no live price'), 'bonds wait for a live $WRAITH price');
    ok((await act('/api/redeem', A, { amount: 10 })).error.includes('no live price'), 'redeem waits for a live $WRAITH price');
    const st = await act('/api/stake', A, { amount: 50 });
    ok(st.ok && st.vigil.staked === 50, 'stake 50 wUSD in the vigil');
    const wd = await act('/api/withdraw', A, { amount: 20 });
    ok(wd.ok && wd.queued.wallet === A.addr && wd.usdc === 480, 'withdraw 20 USDC → payout queue, case-sensitive wallet kept');
    const m1 = await fetch(URL0 + '/api/metrics').then((r) => r.json());
    ok(m1.wusdSupply === 500 && m1.collateralUsd === 450 && m1.shielded.txCount >= 4 && m1.feed.every((t) => !('proof' in t)), 'metrics move only on real actions');
  } catch (e) { fail++; console.log('  ✗ crashed: ' + (e.stack || e)); }
  srv.kill(); try { fs.unlinkSync(DATA); } catch (e) {}
  console.log((fail ? 'FAIL' : 'ALL PASS') + ' (' + pass + '/' + (pass + fail) + ')'); process.exitCode = fail ? 1 : 0;
})();
