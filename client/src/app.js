'use strict';
const $ = (id) => document.getElementById(id);
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
async function api(u, b) {
  if (!b) return fetch(u).then((r) => r.json());
  const withAuth = () => (b.wallet && b.wallet === wallet && getAuth() ? Object.assign({}, b, { auth: getAuth() }) : b);
  let r = await post(u, withAuth());
  if (r && r.auth) { const ok = await signIn(); if (ok) r = await post(u, withAuth()); }
  return r;
}
const fmt = (n, d = 2) => (n == null || !isFinite(n)) ? '—' : (+n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const big = (n) => Math.abs(n) >= 1e6 ? fmt(n / 1e6, 2) + 'M' : Math.abs(n) >= 1e3 ? fmt(n / 1e3, 1) + 'K' : fmt(n, 0);
const ago = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? Math.floor(s) + 's ago' : Math.floor(s / 60) + 'm ago'; };
function toast(m, err) { const t = $('toast'); t.textContent = m; t.className = 'toast on' + (err ? ' err' : ''); clearTimeout(toast._t); toast._t = setTimeout(() => t.className = 'toast', 2400); }

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58dec(x) { let n = 0n; for (const ch of x) { const i = B58.indexOf(ch); if (i < 0) throw new Error('b58'); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const ch of x) { if (ch === '1') out.unshift(0); else break; } return new Uint8Array(out); }
function b58enc(bytes) { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let o = ''; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } for (const x of bytes) { if (x === 0) o = '1' + o; else break; } return o; }
const isSolAddr = (v) => { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v || '')) return false; try { return b58dec(v).length === 32; } catch (e) { return false; } };
let M = null, A = null, tab = 'mint', reveal = false;
const dur = (ms) => { const d = Math.floor(ms / 864e5), hh = Math.floor(ms % 864e5 / 36e5), mm = Math.floor(ms % 36e5 / 6e4); return d > 0 ? d + 'd ' + hh + 'h' : hh + 'h ' + mm + 'm'; };
let wallet = localStorage.getItem('wraith_w') || '';
let refParam = ''; try { const q = new URLSearchParams(location.search); if (isSolAddr(q.get('ref') || '')) { refParam = q.get('ref'); localStorage.setItem('wraith_ref', refParam); } else refParam = localStorage.getItem('wraith_ref') || ''; } catch (e) {}

function setConnected() { const b = $('connect'); b.textContent = wallet ? wallet.slice(0, 4) + '…' + wallet.slice(-4) : 'Connect'; }
const sol = () => (window.phantom && window.phantom.solana) || window.solana || null;
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
$('connect').onclick = async () => {
  if (wallet) {                                                   // already connected -> disconnect
    localStorage.removeItem(AKEY()); wallet = ''; localStorage.removeItem('wraith_w'); A = null; setConnected(); renderAccount(); try { const ph = sol(); if (ph && ph.disconnect) ph.disconnect(); } catch (e) {} toast('disconnected'); return;
  }
  await connectPhantom();
};
$('wmodal').onclick = (e) => { if (e.target.id === 'wmodal') $('wmodal').classList.remove('on'); };
$('wsave').onclick = async () => { const v = $('waddr').value.trim(); if (!isSolAddr(v)) return toast('invalid Solana address', true); wallet = v; localStorage.setItem('wraith_w', v); setConnected(); $('wmodal').classList.remove('on'); toast('file opened'); await loadAccount(); };
function needWallet() { if (!wallet) { connectPhantom(); return true; } return false; }
$('cta-demo').onclick = () => $('demo').scrollIntoView({ behavior: 'smooth' });

// ---------- metrics ----------
async function loadMetrics() { M = await api('/api/metrics'); renderMetrics(); }
function renderMetrics() {
  if (!M) return;
  const pegEl = $('s-peg'); pegEl.textContent = '$' + fmt(M.wusdPrice, 4); pegEl.className = 'v peg ' + M.pegStatus;
  $('s-cr').textContent = fmt(M.cr * 100, 1) + '%';
  $('s-col').textContent = '$' + big(M.collateralUsd);
  $('s-sup').textContent = big(M.wusdSupply) + ' wUSD';
  $('s-shd').textContent = big(M.shielded.totalValue) + ' wUSD';
  if (M.mint) { $('cabar').style.display = 'flex'; $('ca-mint').textContent = M.mint; }
  
  if (M.dark) { const D = M.dark;
    $('tape').innerHTML = D.markets.map((m) => `<div class="m ${m.fresh ? '' : 'closed'}"><div class="s">${m.sym}</div><div class="p">${m.px ? '$' + fmt(m.px, m.px < 10 ? 4 : 2) : '—'}</div><div class="st">${m.fresh ? 'live' : 'closed'}</div></div>`).join('');
    $('dk-open').textContent = fmt(D.open, 0); $('dk-vol').textContent = '$' + big(D.volume); $('dk-fees').textContent = '$' + fmt(D.fees, 2);
  }
  if (M.bonds && !(M.wraithPrice > 0)) { ['bd-price', 'bd-market', 'fg-price'].forEach((i) => ($(i).textContent = 'at launch')); $('bd-left').textContent = '$' + fmt(M.bonds.capUsd, 0) + ' / day'; $('bd-sold').textContent = '$' + fmt(M.bonds.soldUsd, 0); $('fg-locked').textContent = '0 WRAITH'; }
  else if (M.bonds) { const Bd = M.bonds;
    $('bd-price').textContent = '$' + fmt(Bd.price, 6); $('bd-market').textContent = '$' + fmt(Bd.market, 6); $('bd-left').textContent = '$' + fmt(Bd.leftToday, 0) + ' / $' + fmt(Bd.capUsd, 0); $('bd-sold').textContent = '$' + fmt(Bd.soldUsd, 0) + ' · ' + big(Bd.soldWraith) + ' WRAITH'; if (Bd.forge) { $('fg-price').textContent = '$' + fmt(Bd.forge.price, 6) + ' (−' + fmt(Bd.forge.discount * 100, 0) + '%)'; $('fg-locked').textContent = big(Bd.forge.lockedWraith) + ' WRAITH · ' + Bd.forge.n + ' forged'; }
  }
  if (M.vigil) { const V = M.vigil;
    $('v-apy').textContent = fmt(V.apy * 100, 0) + '%'; $('v-boost').textContent = V.boost && V.boost.live ? '⚡ boosted from ' + fmt(V.baseApy * 100, 0) + '% · ' + dur(V.boost.endsIn) + ' left' : ''; $('v-staked').textContent = big(V.staked) + ' / ' + big(V.cap);
    $('v-pool').textContent = big(V.poolLeft) + ' WRAITH'; $('v-ends').textContent = V.startsIn > 0 ? 'opens in ' + dur(V.startsIn) : V.live ? dur(V.endsIn) : 'ended'; $('v-n').textContent = fmt(V.stakers, 0);
  }
  
  if (M.ferry) { const Fm = M.ferry;
    $('ferryboard').innerHTML = Fm.board.map((b, i) => `<div class="r"><span class="ty">#${i + 1}</span><span class="sg">${b.who}</span><span class="am">${b.souls} referred · ${fmt(b.earned, 2)} wUSD</span></div>`).join('') || '<div class="r"><span class="sg">no referrals yet — write the first Note</span></div>';
  }
  if (M.pyre) { const P = M.pyre;
    $('p-wraith').textContent = big(P.burnedWraith) + ' WRAITH'; $('p-usd').textContent = '$' + big(P.burnedUsd);
    $('p-toll').textContent = '$' + fmt(P.tollUsd, 2) + ' / $' + P.minUsd; $('p-ep').textContent = fmt(P.epochs, 0);
    $('pyrefeed').innerHTML = P.burns.map((b) => `<div class="r"><span class="ty burn">burn</span><span class="sg">epoch ${b.epoch} · ${b.id} · @ $${fmt(b.px, 6)}</span><span class="am">🔥 ${fmt(b.wraith, 1)} WRAITH</span></div>`).join('') || '<div class="r"><span class="sg">the pyre is gathering its first toll…</span></div>';
  }
  $('feed').innerHTML = (M.feed.length ? M.feed : []).map((t) => {
    const right = t.type === 'private' ? '<span class="redact">█████</span>'
      : t.publicAmount != null ? fmt(t.publicAmount, 0) + ' wUSD' : '<span class="redact">████</span>';
    const ty = t.type === 'private' ? 'private' : t.type;
    return `<div class="r"><span class="ty ${t.type}">${ty}</span><span class="sg">${t.sig}</span><span class="am">${right}</span></div>`;
  }).join('') || '<div class="r"><span class="sg">no entries yet</span></div>';
}

// ---------- account ----------
async function loadAccount() { if (!wallet) { A = null; renderAccount(); return; } A = await post('/api/account', { wallet, ref: refParam || undefined, auth: getAuth() || undefined }); if (A.error) { toast(A.error, true); A = null; } renderAccount(); }
function renderAccount() {
  if (wallet) { $('ferrybox').style.display = 'flex'; $('ferrylink').textContent = location.origin + '/?ref=' + wallet; } else $('ferrybox').style.display = 'none';
  $('f-souls').textContent = A ? fmt(A.souls, 0) : '—'; $('f-earned').textContent = A ? fmt(A.earned, 2) + ' wUSD' : '—';
  $('b-usdc').textContent = A ? fmt(A.usdc, 0) : '—';
  $('b-wraith').textContent = A ? fmt(A.wraith, 1) : '—';
  $('b-wusd').textContent = A ? fmt(A.wusd, 2) : '—';
  renderPriv();
  renderPanel();
}
function renderPriv() {
  const red = $('b-priv-red'), val = $('b-priv-val');
  if (reveal && A && A.priv == null) { reveal = false; signIn().then((ok) => { if (ok) { reveal = true; loadAccount(); } }); }
  if (reveal && A && A.priv != null) { red.style.display = 'none'; val.style.display = ''; val.textContent = fmt(A.priv, 2); $('b-priv-eye').textContent = 'hide'; }
  else { red.style.display = ''; val.style.display = 'none'; $('b-priv-eye').textContent = 'reveal'; }
}
$('b-priv-eye').onclick = () => { reveal = !reveal; renderPriv(); };
$('b-seal').onclick = async () => { if (needWallet()) return; const r = await api('/api/seal', { wallet }); if (r.error) return toast(r.error, true); tab = 'seal'; sealKey = r.viewKey; document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('on')); renderPanel(); $('demo').scrollIntoView({ behavior: 'smooth' }); };
let sealKey = '', claimSecret = '', lastNote = null;

// ---------- demo tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); renderPanel(); });
function renderPanel() {
  const p = $('panel'); const cr = M ? M.cr : 0.9, vp = M ? M.wraithPrice : 0;
  if (tab === 'seal') {
    const url = location.origin + '/view#' + sealKey;
    p.innerHTML = `<div class="note"><b>The Seal.</b> This view key opens a read-only statement of your shielded balance and history. It <b>cannot spend</b>. Give it only to who you want to see.</div>
      <div class="linkbox"><code id="vk">${url}</code><button id="cp">Copy</button></div>
      <div class="kv" style="margin-top:12px"><span>opens</span><b><a href="${url}" target="_blank" style="color:var(--acid-ink)">sealed statement ↗</a></b></div>`;
    $('cp').onclick = () => { navigator.clipboard.writeText(url); toast('view key copied'); };
  } else if (tab === 'claim') {
    p.innerHTML = `<div class="note"><b>Someone sent you a Note.</b> Private wUSD is locked behind this link. Claim it into your shielded balance.</div>
      <div class="kv"><span>amount</span><b id="cl-amt">…</b></div><div class="kv"><span>memo</span><b id="cl-memo">—</b></div>
      <button class="btn wide" id="act" style="margin-top:14px">Claim into my shielded balance</button>`;
    api('/api/note/peek', { secret: claimSecret }).then((r) => { if (r.error) { $('cl-amt').textContent = r.error; $('act').disabled = true; return; } $('cl-amt').textContent = r.claimed ? 'already claimed' : fmt(r.amt, 2) + ' wUSD'; $('cl-memo').textContent = r.memo || '—'; if (r.claimed) $('act').disabled = true; });
    $('act').onclick = () => doAct('/api/note/claim', { secret: claimSecret, amount: 1 }, (r) => { history.replaceState(null, '', location.pathname); tab = 'send'; renderPanel(); return `claimed ${fmt(r.claimed, 2)} wUSD — privately`; });
  } else if (tab === 'dark') {
    const D = M && M.dark, pos = (A && A.dark) || [];
    p.innerHTML = `<div class="note"><b>The Dark Pool.</b> Commit shielded wUSD to a stock. Long or short, 1x, live tape. Ticker, size and P&amp;L stay in the shield. 30 bps each way.</div>
      <div style="display:flex;gap:10px"><div class="field" style="flex:1"><select id="sym" style="flex:1;background:none;border:none;color:var(--ink);font-family:'JetBrains Mono';font-size:15px;outline:none">${(D ? D.markets : []).map((m) => `<option value="${m.sym}" ${m.fresh ? '' : 'disabled'}>${m.sym} ${m.px ? '· $' + fmt(m.px, 2) : ''}${m.fresh ? '' : ' · closed'}</option>`).join('')}</select></div>
      <div class="field" style="flex:0 0 150px"><select id="side" style="flex:1;background:none;border:none;color:var(--ink);font-family:'JetBrains Mono';font-size:15px;outline:none"><option value="long">LONG</option><option value="short">SHORT</option></select></div></div>
      <div class="field"><input id="in" type="number" placeholder="10.00 minimum" min="10"><span class="u">wUSD</span><span class="mx" id="mx">MAX</span></div>
      <div class="kv"><span>Shielded balance</span><b>${A ? (reveal ? fmt(A.priv, 2) : '████') : '—'}</b></div><div class="kv"><span>Per position · pool</span><b>${D ? 'max ' + fmt(D.maxPos, 0) + ' · ' + (D.full ? 'full' : 'open') : '—'}</b></div>
      <button class="btn fill wide" id="act" style="margin-top:14px">Open unseen</button>
      ${pos.length ? '<div style="margin-top:16px">' + pos.map((q) => `<div class="pos"><b>${q.sym}</b><span>${q.side}</span><span class="sg" style="font-family:'JetBrains Mono';font-size:12px;color:var(--mut)">${fmt(q.notional, 2)} @ ${fmt(q.entry, 2)} → ${fmt(q.px, 2)}</span><span class="pnl ${q.pnl >= 0 ? 'up' : 'dn'}">${q.pnl >= 0 ? '+' : ''}${fmt(q.pnl, 2)}</span><button data-close="${q.id}" ${q.fresh ? '' : 'disabled'}>Close</button></div>`).join('') + '</div>' : ''}`;
    $('mx').onclick = () => { if (A) $('in').value = Math.min(A.priv, D ? D.maxPos : 1000); };
    $('act').onclick = () => doAct('/api/dark/open', { sym: $('sym').value, side: $('side').value, amount: +$('in').value }, (r) => `opened ${r.opened.side} ${r.opened.sym} — unseen`);
    p.querySelectorAll('[data-close]').forEach((b) => b.onclick = () => doAct('/api/dark/close', { id: b.dataset.close, amount: 1 }, (r) => `closed · ${r.closed.pnl >= 0 ? '+' : ''}${fmt(r.closed.pnl, 2)} wUSD`));
  } else if (tab === 'bond') {
    const Bd = M && M.bonds, me = A && A.bonds;
    const F = Bd && Bd.forge; if (typeof window.__lock === 'undefined') window.__lock = true; const L = window.__lock;
    p.innerHTML = `<div class="note"><b>Bond USDC for $WRAITH at ${Bd ? fmt(Bd.discount * 100, 0) : 20}% below market.</b> Vests over ${Bd ? Bd.vestDays : 5} days. Your USDC goes to the reserve and mints nothing. ${Bd && !Bd.open ? '<b>Bonds are closed.</b>' : ''}</div>
      <div style="display:flex;gap:8px;margin:0 0 12px"><button class="btn ${L ? 'fill' : 'ghost'}" id="lk1" style="flex:1.3">🔥 THE FORGE · lock ${F ? F.lockDays * 24 : 48}h · −${F ? fmt(F.discount * 100, 0) : 30}% · ${F ? fmt(F.apy * 100, 0) : 80}% APY</button><button class="btn ${L ? 'ghost' : 'fill'}" id="lk0" style="flex:1">Plain bond · −${Bd ? fmt(Bd.discount * 100, 0) : 20}% · ${Bd ? Bd.vestDays : 5}d vest</button></div>
      ${L ? `<div class="note" style="border-color:var(--ink)"><b>The Forge:</b> your USDC enters the bond pool, you take $WRAITH at <b>${F ? fmt(F.discount * 100, 0) : 30}% below market</b>, locked <b>${F ? F.lockDays * 24 : 48} hours</b>. While locked it earns <b>${F ? fmt(F.apy * 100, 0) : 80}% APY in $WRAITH</b>, paid from the Vigil's fixed pool. Nothing printed. Claim principal + yield at unlock.</div>` : ''}
      <div class="field"><input id="in" type="number" placeholder="50.00 minimum" min="50"><span class="u">USDC</span><span class="mx" id="mx">MAX</span></div>
      <div class="kv"><span>USDC on ledger</span><b>${A ? fmt(A.usdc, 2) : '—'}</b></div>
      <div class="kv"><span>${L ? 'forge' : 'bond'} price · market</span><b>${Bd ? '$' + fmt(L && F ? F.price : Bd.price, 6) + ' · $' + fmt(Bd.market, 6) : '—'}</b></div>
      <div class="kv"><span>you receive</span><b id="o1">—</b></div>
      ${L ? '<div class="kv"><span>yield at unlock</span><b id="o2">—</b></div>' : ''}
      <div class="kv"><span>vesting · claimable now</span><b>${me ? big(me.pending) + ' · ' + big(me.claimable) + ' WRAITH' : '—'}</b></div>
      ${me && me.locked ? `<div class="kv"><span>in the forge · yield forging</span><b style="color:var(--acid-ink)">${big(me.locked)} · +${big(me.forging)} WRAITH</b></div>` : ''}
      <div style="display:flex;gap:10px;margin-top:14px"><button class="btn fill" id="act" style="flex:1.4">${L ? '🔥 Forge WRAITH' : 'Bond USDC'}</button><button class="btn ghost" id="act2" style="flex:1">Claim vested</button><button class="btn ghost" id="act3" style="flex:1">Withdraw WRAITH</button></div>
      <div class="note" style="margin-top:12px;margin-bottom:0">No USDC yet? <a href="#" id="go-dep" style="color:var(--ink);text-decoration:underline">Deposit first →</a></div>`;
    $('mx').onclick = () => { if (A) $('in').value = A.usdc; };
    $('in').oninput = () => { const x = +$('in').value || 0; const px = L && F ? F.price : (Bd && Bd.price); $('o1').textContent = Bd ? big(x / px) + ' WRAITH (' + big(x / Bd.market) + ' at market)' : '—'; if (L && F && $('o2')) $('o2').textContent = '+' + big(x / px * F.apy * F.lockDays / 365) + ' WRAITH (' + fmt(F.apy * 100, 0) + '% APY × ' + F.lockDays * 24 + 'h)'; };
    $('lk1').onclick = () => { window.__lock = true; renderPanel(); }; $('lk0').onclick = () => { window.__lock = false; renderPanel(); };
    $('act').onclick = () => doAct('/api/bond', { amount: +$('in').value, lock: L }, (r) => r.lock ? `forged ${fmt(r.bonded, 2)} USDC → ${big(r.wraithOut)} WRAITH locked ${F.lockDays * 24}h at ${fmt(r.apy * 100, 0)}% APY` : `bonded ${fmt(r.bonded, 2)} USDC → ${big(r.wraithOut)} WRAITH vesting`);
    $('act2').onclick = () => doAct('/api/bond/claim', { amount: 1 }, (r) => `claimed ${big(r.claimedWraith)} WRAITH${r.forgedWraith > 0 ? ' (incl. ' + big(r.forgedWraith) + ' forged yield)' : ''}`);
    $('act3').onclick = () => doAct('/api/withdraw', { asset: 'WRAITH', amount: A ? A.wraith : 0 }, (r) => `queued ${big(r.queued.amt)} WRAITH for payout`);
    $('go-dep').onclick = (e) => { e.preventDefault(); tab = 'deposit'; document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'deposit')); renderPanel(); };
  } else if (tab === 'deposit') {
    p.innerHTML = `<div class="note">Send <b>USDC on Solana</b> from Phantom. The server reads the confirmed transaction and credits your ledger with exactly what landed in the treasury. Minimum ${M ? M.minDeposit : 50} USDC.</div>
      <div class="field"><input id="in" type="number" placeholder="50.00 minimum" min="50"><span class="u">USDC</span></div>
      <div class="kv"><span>Treasury USDC on-chain</span><b>${M && M.chain && M.chain.ok && M.depositsOpen ? '$' + fmt(M.chain.treasuryUsdc, 2) : '—'}</b></div>
      <div class="kv"><span>Credited so far</span><b>${A ? fmt(A.deposited, 2) + ' USDC' : '—'}</b></div>
      <button class="btn wide" id="act" style="margin-top:14px">Send USDC from wallet</button>
      <div class="note" style="margin-top:14px;margin-bottom:8px">Already sent? Paste the transaction signature:</div>
      <div class="field"><input id="tx" placeholder="transaction signature" spellcheck="false"></div>
      <button class="btn ghost wide" id="act2">Credit my deposit</button>`;
    $('act').onclick = () => sendUsdc(+$('in').value);
    $('act2').onclick = () => doAct('/api/deposit', { tx: ($('tx').value || '').trim(), amount: 1 }, (r) => `credited ${fmt(r.amt, 2)} USDC from the treasury deposit`);
  } else if (tab === 'vigil') {
    const V = M && M.vigil, me = A && A.vigil;
    p.innerHTML = `<div class="note">Stake public wUSD in <b>The Vigil</b>: <b>${V ? fmt(V.apy * 100, 0) : '—'}% APY</b> for 30 days, paid in <b>$WRAITH</b> from a pre-funded pool. Unstake any time (30 bps toll). ${V && !V.live ? '<b>The vigil is ' + (V.startsIn > 0 ? 'not open yet' : 'over') + '.</b>' : ''}</div>
      <div class="field"><input id="in" type="number" placeholder="0.00" min="0"><span class="u">wUSD</span><span class="mx" id="mx">MAX</span></div>
      <div class="kv"><span>Public wUSD</span><b>${A ? fmt(A.wusd, 2) : '—'}</b></div>
      <div class="kv"><span>Keeping vigil</span><b>${me ? fmt(me.staked, 2) + ' wUSD' : '—'}</b></div>
      <div class="kv"><span>Earned · claimable</span><b>${me ? fmt(me.accruedWraith, 1) + ' WRAITH (≈ $' + fmt(me.accruedUsd, 4) + ')' : '—'}</b></div>
      <div style="display:flex;gap:10px;margin-top:14px"><button class="btn" id="act" style="flex:1">Stake</button><button class="btn ghost" id="act2" style="flex:1">Unstake</button><button class="btn ghost" id="act3" style="flex:1">Claim WRAITH</button></div>`;
    $('mx').onclick = () => { if (A) $('in').value = A.wusd; };
    $('act').onclick = () => doAct('/api/stake', { amount: +$('in').value }, (r) => `${fmt(r.staked, 2)} wUSD keeps vigil`);
    $('act2').onclick = () => doAct('/api/unstake', { amount: +$('in').value }, (r) => `unstaked ${fmt(r.unstaked, 2)} wUSD`);
    $('act3').onclick = () => doAct('/api/claim', { amount: 1 }, (r) => `claimed ${fmt(r.claimedWraith, 1)} WRAITH`);
  } else if (tab === 'mint') {
    p.innerHTML = `<div class="note">Mint $1-pegged <b>wUSD</b> with deposited USDC: <b>${fmt(cr * 100, 0)}% goes to collateral</b>, the <b>${fmt((1 - cr) * 100, 0)}% algorithmic share buys WRAITH at market and burns it</b>. Nothing is printed.</div>
      <div class="field"><input id="in" type="number" placeholder="0.00" min="0"><span class="u">wUSD</span></div>
      <div class="kv"><span>USDC collateral (${fmt(cr * 100, 0)}%)</span><b id="o1">—</b></div><div class="kv"><span>USDC → buys &amp; burns WRAITH (${fmt((1 - cr) * 100, 0)}%)</span><b id="o2">—</b></div>
      <button class="btn wide" id="act" style="margin-top:14px">Mint wUSD</button>`;
    $('in').oninput = () => { const m = +$('in').value || 0; $('o1').textContent = fmt(m * cr, 2) + ' USDC'; $('o2').textContent = fmt(m * (1 - cr), 2) + ' USDC' + (vp > 0 ? ' ≈ ' + fmt((m * (1 - cr)) / vp, 0) + ' WRAITH' : ' · burned at market once $WRAITH trades'); };
    $('act').onclick = () => doAct('/api/mint', { amount: +$('in').value }, (r) => `minted ${fmt(r.minted, 0)} wUSD`);
  } else if (tab === 'shield') {
    p.innerHTML = `<div class="note">Move public wUSD into the <b>shielded pool</b>. It becomes a note <b>encrypted only to you</b> — your balance reads <span class="redact">████</span> on-chain.</div>
      <div class="field"><input id="in" type="number" placeholder="0.00" min="0"><span class="u">wUSD</span><span class="mx" id="mx">MAX</span></div>
      <div class="kv"><span>Public wUSD available</span><b>${A ? fmt(A.wusd, 2) : '—'}</b></div>
      <button class="btn wide" id="act" style="margin-top:14px">Shield wUSD</button>`;
    $('mx').onclick = () => { if (A) $('in').value = A.wusd; };
    $('act').onclick = () => doAct('/api/shield', { amount: +$('in').value }, (r) => `shielded ${fmt(r.shielded, 2)} wUSD`);
  } else if (tab === 'send') {
    p.innerHTML = `<div class="note">Send shielded wUSD. The <b>amount and both parties are hidden</b> — the ledger records only a nullifier + a new commitment.</div>
      <div class="field"><input id="to" placeholder="recipient Solana address…" spellcheck="false"></div>
      <div class="field"><input id="in" type="number" placeholder="0.00" min="0"><span class="u">wUSD</span><span class="mx" id="mx">MAX</span></div>
      <div class="kv"><span>Your private balance</span><b>${A ? (reveal ? fmt(A.priv, 2) : '████') : '—'}</b></div>
      <button class="btn wide" id="act" style="margin-top:14px">Send privately</button>
      <div class="note" style="margin:18px 0 8px"><b>Or write a Note:</b> no address needed. Lock the amount above behind a link and send the link to anyone.</div>
      <div class="field"><input id="memo" placeholder="memo (optional, seen only by the claimer)" maxlength="80"></div>
      <button class="btn ghost wide" id="act2">Create pay link</button>
      ${lastNote ? '<div class="linkbox"><code>' + lastNote + '</code><button id="cpn">Copy</button></div>' : ''}`;
    $('mx').onclick = () => { if (A) $('in').value = A.priv; };
    $('act').onclick = () => doAct('/api/send', { to: ($('to').value || '').trim(), amount: +$('in').value }, (r) => `sent ${fmt(r.sent, 2)} wUSD — privately`);
    $('act2').onclick = () => doAct('/api/note/create', { amount: +$('in').value, memo: $('memo').value }, (r) => { lastNote = location.origin + '/#claim=' + r.secret; renderPanel(); return `note written for ${fmt(r.amt, 2)} wUSD — copy the link`; });
    if ($('cpn')) $('cpn').onclick = () => { navigator.clipboard.writeText(lastNote); toast('link copied'); };
  } else {
    p.innerHTML = `<div class="note">Burn wUSD to recover your <b>${fmt(cr * 100, 0)}% USDC</b> plus the <b>${fmt((1 - cr) * 100, 0)}% WRAITH</b> share. (Unshield private wUSD first to redeem it.)</div>
      <div class="field"><input id="in" type="number" placeholder="0.00" min="0"><span class="u">wUSD</span><span class="mx" id="mx">MAX</span></div>
      <div class="kv"><span>Public wUSD</span><b>${A ? fmt(A.wusd, 2) : '—'}</b></div>
      <div class="kv"><span>USDC on ledger</span><b>${A ? fmt(A.usdc, 2) : '—'}</b></div>
      <div style="display:flex;gap:10px;margin-top:14px"><button class="btn ghost" id="act2" style="flex:1">Unshield</button><button class="btn" id="act" style="flex:1">Redeem</button><button class="btn ghost" id="act3" style="flex:1">Withdraw USDC</button></div>
      ${A && A.queue && A.queue.length ? '<div class="note" style="margin-top:14px">' + A.queue.map((q) => '<div class="kv"><span>withdraw ' + fmt(q.amt, 2) + ' ' + (q.asset || 'USDC') + ' · ' + q.id + '</span><b>' + (q.status === 'paid' ? 'paid' + (q.tx ? ' · ' + q.tx.slice(0, 10) + '…' : '') : 'queued · treasury pays within 24h') + '</b></div>').join('') + '</div>' : ''}`;
    $('mx').onclick = () => { if (A) $('in').value = A.wusd; };
    $('act').onclick = () => doAct('/api/redeem', { amount: +$('in').value }, (r) => `redeemed ${fmt(r.redeemed, 0)} wUSD`);
    $('act2').onclick = () => doAct('/api/unshield', { amount: +$('in').value }, (r) => `unshielded ${fmt(r.unshielded, 2)} wUSD`);
    $('act3').onclick = () => doAct('/api/withdraw', { amount: +$('in').value }, (r) => `queued ${fmt(r.queued.amt, 2)} USDC for payout`);
  }
}
async function sendUsdc(amount) {
  if (needWallet()) return; if (!amount || amount <= 0) return toast('enter an amount', true); const minDep = (M && M.minDeposit) || 50; if (amount < minDep) return toast('minimum deposit is ' + minDep + ' USDC', true);
  const ph = sol(); if (!ph || !ph.request) return toast('open Phantom to send USDC, or paste a signature', true);
  try {
    const I = await api('/api/deposit/intent', { wallet, amount }); if (I.error) return toast(I.error, true);
    if (amount > I.balance) return toast('this wallet holds ' + fmt(I.balance, 2) + ' USDC', true);
    const msg = usdcTransferMessage(wallet, I.source, I.dest, I.mint, I.program, I.blockhash, Math.round(amount * 10 ** I.decimals), I.decimals);
    const r = await ph.request({ method: 'signAndSendTransaction', params: { message: b58enc(msg) } }); const sig = r.signature || r;
    toast('sent · waiting for Solana to confirm…');
    for (let i = 0; i < 40; i++) { await new Promise((ok) => setTimeout(ok, 2500)); const c = await api('/api/deposit', { wallet, tx: sig }); if (c.ok) { A = c; renderAccount(); loadMetrics(); return toast(`credited ${fmt(c.amt, 2)} USDC`); } if (c.error && !/not found/.test(c.error)) return toast(c.error, true); }
    toast('still confirming: paste the signature to credit later', true);
  } catch (e) { toast(errText(e), true); }
}
async function doAct(url, payload, msg) {
  if (needWallet()) return;
  if (!payload.amount) return toast('enter an amount', true);
  const r = await api(url, Object.assign({ wallet }, payload));
  if (r.error) return toast(r.error, true);
  A = r; renderAccount(); loadMetrics(); toast(msg(r));
}
$('ferrycopy').onclick = () => { navigator.clipboard.writeText(location.origin + '/?ref=' + wallet); toast('referral link copied'); };
$('ca-copy').onclick = () => { navigator.clipboard.writeText(M.mint); toast('copied'); };


// deep-link / capture: ?w=<address> opens a wallet's ledger, &tab=<mint|shield|send|redeem>, &reveal=1
(function () { const q = new URLSearchParams(location.search); const hm = /claim=([1-9A-HJ-NP-Za-km-z]+)/.exec(location.hash || ''); if (hm) { claimSecret = hm[1]; tab = 'claim'; setTimeout(() => $('demo').scrollIntoView(), 400); }
  if (q.get('w')) wallet = q.get('w');
  if (q.get('tab')) tab = q.get('tab');
  if (q.get('reveal') === '1') reveal = true; })();

document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));

(async function () { await api('/api/config'); setConnected(); await loadMetrics(); await loadAccount(); renderPanel(); setInterval(loadMetrics, 5000); })();
