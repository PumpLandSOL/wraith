// One-time port of the STYX client (EVM on Robinhood Chain) to Phantom on Solana. Run from wraith/: node _studio/port-client.cjs
const fs = require('fs'), p = 'client/src/app.js'; let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('nomatch: ' + a.slice(0, 80)); s = s.split(a).join(b); };

// api(): every POST for the connected wallet carries its signed session; a refused session triggers one sign-in and a retry
rep(`const api = (u, b) => fetch(u, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined).then((r) => r.json());`,
`const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
async function api(u, b) {
  if (!b) return fetch(u).then((r) => r.json());
  const withAuth = () => (b.wallet && b.wallet === wallet && getAuth() ? Object.assign({}, b, { auth: getAuth() }) : b);
  let r = await post(u, withAuth());
  if (r && r.auth) { const ok = await signIn(); if (ok) r = await post(u, withAuth()); }
  return r;
}`);
rep(`let refParam = ''; try { const q = new URLSearchParams(location.search); if (/^0x[a-fA-F0-9]{40}$/.test(q.get('ref') || '')) { refParam = q.get('ref').toLowerCase(); localStorage.setItem('wraith_ref', refParam); }`,
`let refParam = ''; try { const q = new URLSearchParams(location.search); if (isSolAddr(q.get('ref') || '')) { refParam = q.get('ref'); localStorage.setItem('wraith_ref', refParam); }`);

// wallet: Phantom (window.phantom.solana / window.solana) + signed session + hand-built SPL transfer
const w0 = s.indexOf(`const CHAIN_HEX = '0x1237';`), w1 = s.indexOf(`$('connect').onclick`);
s = s.slice(0, w0) + `const sol = () => (window.phantom && window.phantom.solana) || window.solana || null;
const errText = (e) => { const m = (e && (e.message || (e.error && e.error.message))) || String(e || ''); if ((e && e.code === 4001) || /reject|denied|cancel/i.test(m)) return 'request rejected in your wallet'; return m.slice(0, 120) || 'wallet error'; };
// signed session: one free message signature proves the wallet is yours. Nothing that moves value works without it.
const AKEY = () => 'wraith_auth_' + wallet;
function getAuth() { try { const x = JSON.parse(localStorage.getItem(AKEY()) || 'null'); return x && x.exp > Date.now() + 6e4 ? x : null; } catch (e) { return null; } }
async function signIn() {
  if (!wallet) return false; if (getAuth()) return true; const ph = sol();
  if (!ph || !ph.signMessage) { toast('connect Phantom to sign in (a pasted address is read-only)', true); return false; }
  try { const m = await (await fetch('/api/session?wallet=' + wallet)).json(); if (m.error) throw new Error(m.error);
    toast('sign the message in Phantom (free, no transaction)');
    const r = await ph.signMessage(new TextEncoder().encode(m.message), 'utf8'); const sig = r && (r.signature || r);
    localStorage.setItem(AKEY(), JSON.stringify({ exp: m.exp, sig: b58enc(new Uint8Array(sig)) })); return true;
  } catch (e) { toast(errText(e), true); return false; }
}
async function connectPhantom() {
  const ph = sol(); if (!ph) { $('wmodal').classList.add('on'); return; }   // no wallet: paste an address to read it
  try { const r = await ph.connect(); const pk = (r && r.publicKey ? r.publicKey : ph.publicKey).toString(); if (!isSolAddr(pk)) throw new Error('wallet returned no Solana address');
    wallet = pk; localStorage.setItem('wraith_w', pk); setConnected(); await signIn(); toast('connected · Solana'); await loadAccount();
  } catch (e) { toast(errText(e), true); }
}
(function () { const ph = sol(); if (ph && ph.on) ph.on('accountChanged', (pk) => { if (pk) { wallet = pk.toString(); localStorage.setItem('wraith_w', wallet); setConnected(); loadAccount(); } }); })();
// SPL TransferChecked, built by hand (no SDK): keys [owner, source, dest, mint, token program], one instruction
function usdcTransferMessage(owner, source, dest, mint, program, blockhash, units, decimals) {
  const K = [owner, source, dest, mint, program].map(b58dec), H = b58dec(blockhash);
  const data = new Uint8Array(10); data[0] = 12; let v = BigInt(units); for (let i = 0; i < 8; i++) { data[1 + i] = Number(v & 255n); v >>= 8n; } data[9] = decimals;
  return new Uint8Array([1, 0, 2, 5, ...K.flatMap((k) => [...k]), ...H, 1, 4, 4, 1, 3, 2, 0, data.length, ...data]);
}
` + s.slice(w1);
rep(`wallet = ''; localStorage.removeItem('wraith_w'); A = null; setConnected(); renderAccount(); toast('disconnected'); return;`,
`localStorage.removeItem(AKEY()); wallet = ''; localStorage.removeItem('wraith_w'); A = null; setConnected(); renderAccount(); try { const ph = sol(); if (ph && ph.disconnect) ph.disconnect(); } catch (e) {} toast('disconnected'); return;`);
rep(`$('wsave').onclick = async () => { const v = $('waddr').value.trim(); if (!/^0x[a-fA-F0-9]{40}$/.test(v)) return toast('invalid address', true); wallet = v.toLowerCase();`,
`$('wsave').onclick = async () => { const v = $('waddr').value.trim(); if (!isSolAddr(v)) return toast('invalid Solana address', true); wallet = v;`);
// base58 helpers ahead of everything that uses them
rep(`let M = null, A = null, tab = 'mint', reveal = false;`, `const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58dec(x) { let n = 0n; for (const ch of x) { const i = B58.indexOf(ch); if (i < 0) throw new Error('b58'); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const ch of x) { if (ch === '1') out.unshift(0); else break; } return new Uint8Array(out); }
function b58enc(bytes) { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let o = ''; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } for (const x of bytes) { if (x === 0) o = '1' + o; else break; } return o; }
const isSolAddr = (v) => { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v || '')) return false; try { return b58dec(v).length === 32; } catch (e) { return false; } };
let M = null, A = null, tab = 'mint', reveal = false;`);

// private balance: only a signed session sees it
rep(`if (reveal && A) { red.style.display = 'none';`, `if (reveal && A && A.priv == null) { reveal = false; signIn().then((ok) => { if (ok) { reveal = true; loadAccount(); } }); }
  if (reveal && A && A.priv != null) { red.style.display = 'none';`);
rep(`async function loadAccount() { if (!wallet) { A = null; renderAccount(); return; } A = await api('/api/account', { wallet, ref: refParam || undefined });`,
`async function loadAccount() { if (!wallet) { A = null; renderAccount(); return; } A = await post('/api/account', { wallet, ref: refParam || undefined, auth: getAuth() || undefined });`);

// copy + deposit panel
rep(`style="color:var(--gold)">sealed statement ↗</a>`, `style="color:var(--acid-ink)">sealed statement ↗</a>`);
rep(`<div class="note">Send <b>USDC on Robinhood Chain</b> to the treasury and it is credited to your ledger once the receipt confirms. <b>Every deposited dollar sits in the treasury address</b> — see the on-chain balance in the Treasury bar below.</div>`,
`<div class="note">Send <b>USDC on Solana</b> from Phantom. The server reads the confirmed transaction and credits your ledger with exactly what landed in the treasury. Minimum \${M ? M.minDeposit : 50} USDC.</div>`);
rep(`<div class="kv"><span>Treasury</span><b>\${M && M.treasury ? M.treasury.slice(0, 8) + '…' + M.treasury.slice(-6) : '—'}</b></div>`,
`<div class="kv"><span>Treasury USDC on-chain</span><b>\${M && M.chain && M.chain.ok && M.depositsOpen ? '$' + fmt(M.chain.treasuryUsdc, 2) : '—'}</b></div>`);
rep(`<div class="note" style="margin-top:14px;margin-bottom:8px">Already sent? Paste the transaction hash:</div>
      <div class="field"><input id="tx" placeholder="0x… transaction hash" spellcheck="false"></div>`,
`<div class="note" style="margin-top:14px;margin-bottom:8px">Already sent? Paste the transaction signature:</div>
      <div class="field"><input id="tx" placeholder="transaction signature" spellcheck="false"></div>`);
rep(`placeholder="recipient Robinhood Chain address…"`, `placeholder="recipient Solana address…"`);
rep(`style="color:var(--gold2)"`, `style="color:var(--acid-ink)"`);
rep(`<div class="note" style="border-color:var(--gold)">`, `<div class="note" style="border-color:var(--ink)">`);
rep(`style="color:var(--gold)">Deposit first →</a>`, `style="color:var(--ink);text-decoration:underline">Deposit first →</a>`);
rep(`$('o2').textContent = fmt(m * (1 - cr), 2) + ' USDC ≈ ' + fmt((m * (1 - cr)) / vp, 0) + ' WRAITH'; };`,
`$('o2').textContent = fmt(m * (1 - cr), 2) + ' USDC' + (vp > 0 ? ' ≈ ' + fmt((m * (1 - cr)) / vp, 0) + ' WRAITH' : ' · burned at market once $WRAITH trades'); };`);
rep(`const cr = M ? M.cr : 0.9, vp = M ? M.wraithPrice : 0.85;`, `const cr = M ? M.cr : 0.9, vp = M ? M.wraithPrice : 0;`);

// sendUsdc: SPL transfer from Phantom, then poll the server until the deposit is credited
const d0 = s.indexOf('async function sendUsdc(amount) {'), d1 = s.indexOf('async function doAct(');
s = s.slice(0, d0) + `async function sendUsdc(amount) {
  if (needWallet()) return; if (!amount || amount <= 0) return toast('enter an amount', true); const minDep = (M && M.minDeposit) || 50; if (amount < minDep) return toast('minimum deposit is ' + minDep + ' USDC', true);
  const ph = sol(); if (!ph || !ph.request) return toast('open Phantom to send USDC, or paste a signature', true);
  try {
    const I = await api('/api/deposit/intent', { wallet, amount }); if (I.error) return toast(I.error, true);
    if (amount > I.balance) return toast('this wallet holds ' + fmt(I.balance, 2) + ' USDC', true);
    const msg = usdcTransferMessage(wallet, I.source, I.dest, I.mint, I.program, I.blockhash, Math.round(amount * 10 ** I.decimals), I.decimals);
    const r = await ph.request({ method: 'signAndSendTransaction', params: { message: b58enc(msg) } }); const sig = r.signature || r;
    toast('sent · waiting for Solana to confirm…');
    for (let i = 0; i < 40; i++) { await new Promise((ok) => setTimeout(ok, 2500)); const c = await api('/api/deposit', { wallet, tx: sig }); if (c.ok) { A = c; renderAccount(); loadMetrics(); return toast(\`credited \${fmt(c.amt, 2)} USDC\`); } if (c.error && !/not found/.test(c.error)) return toast(c.error, true); }
    toast('still confirming: paste the signature to credit later', true);
  } catch (e) { toast(errText(e), true); }
}
` + s.slice(d1);
fs.writeFileSync(p, s); console.log('client ported');
