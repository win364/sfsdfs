// Clean local server for Mines game (no SW required)
// Usage: node server-fixed.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const ROOT = process.cwd();
const HISTORY_FILE = path.join(ROOT,'prod-rnd-backend-php-orchestra.100hp.app','mines','sessions.html');

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  if (Buffer.isBuffer(body) || typeof body === 'string') return res.end(body);
  if (body == null) return res.end();
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Send SSE message to all connected clients
function sendSSEToAll(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  Store.sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (e) {
      // Remove disconnected clients
      Store.sseClients.delete(client);
    }
  });
}

function contentType(filePath) {
  const m = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'application/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.woff2', 'font/woff2'],
    ['.mp3', 'audio/mpeg'],
  ]);
  const ext = path.extname(filePath).toLowerCase();
  return m.get(ext) || 'application/octet-stream';
}

function safeResolve(urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const target = path.join(ROOT, decoded.replace(/^\/+/, ''));
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(ROOT))) return null;
  return resolved;
}


function readJson(req, cb) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(data||'{}')); } catch { cb({}); } });
  req.on('error', () => cb({}));
}

// -------- Local API store --------
const Store = {
  user: { language: 'ru', currency: 'RUB', sessionId: null, balance: 1000.00, name: 'Player', avatar: '', exchangeRate: 1 },
  // SSE clients for real-time balance updates
  sseClients: new Set(),
  settings: (() => {
    try {
      const p = path.join(ROOT, 'prod-rnd-backend-php-orchestra.100hp.app', 'mines', 'settings.html');
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return {
        supportedCurrencies: ['RUB'],
        bets: { RUB: { quickBets: { min: 1, max: 20000 }, defaultBet: 100, steps: [] } },
        presets: [{ presetValue: 3, isDefault: true }],
        rates: [{ presetValue: 3, rates: [1.09,1.24,1.43,1.65,1.93,2.27,2.69,3.23,3.92] }],
        roundsCount: 25,
      };
    }
  })(),
  activeSession: null,
  history: [],
};

// Move a finished (non-Active) session to history and clear references,
// so a page reload does not resurrect the previous game.
function archiveAndClearIfFinished(){
  const s = Store.activeSession;
  if (!s) return;
  if (s.state && s.state !== 'Active') {
    const ended = publicSession(s);
    if (!Store.history.find(h => h.id === ended.id)) {
      Store.history.unshift(ended);
      saveHistoryToDisk();
    }
    Store.activeSession = null;
    Store.user.sessionId = null;
  }
}

// ---------- History persistence ----------
function loadHistoryFromDisk(){
  try {
    const raw = fs.readFileSync(HISTORY_FILE,'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.data)) {
      Store.history = parsed.data;
    }
  } catch {
    // try fallback sessions-*.html
    try {
      const dir = path.dirname(HISTORY_FILE);
      const files = fs.readdirSync(dir).filter(f=>/^sessions-.*\.html$/i.test(f));
      if (files.length){
        const raw = fs.readFileSync(path.join(dir,files[0]),'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.data)) Store.history = parsed.data;
      }
    } catch {}
  }
}

function saveHistoryToDisk(){
  try {
    const payload = { limit: Store.history.length, offset: 0, data: Store.history };
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(payload), 'utf8');
  } catch {}
}

// load on start
loadHistoryFromDisk();

function getRates(preset) {
  const e = (Store.settings.rates||[]).find(r=>r.presetValue===preset);
  return e ? e.rates.slice() : [];
}
function randomBombs(traps) {
  const set = new Set();
  while (set.size < Math.min(traps,25)) {
    const col = Math.floor(Math.random()*5); const row = Math.floor(Math.random()*5);
    set.add(`${col},${row}`);
  }
  const expectedChoices = [];
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) expectedChoices.push({ value:{col:c,row:r}, category: set.has(`${c},${r}`)?1:0 });
  return { bombs:set, expectedChoices };
}

function bombMatrixFromSet(bombs) {
  const m = Array.from({length:5},()=>Array(5).fill(0));
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) { if (bombs.has(`${c},${r}`)) m[r][c]=1; }
  return m;
}

function generateSaltAndHash(bombs) {
  const left = Math.random().toString(16).slice(2);
  const right = Math.random().toString(16).slice(2);
  const matrix = bombMatrixFromSet(bombs);
  const salt = `${left}|${JSON.stringify(matrix)}|${right}`;
  const hash = crypto.createHash('sha256').update(salt).digest('hex');
  return { salt, hash };
}
function buildSession(amount, presetValue) {
  const id = Math.random().toString(36).slice(2)+Date.now().toString(36);
  const { bombs, expectedChoices } = randomBombs(presetValue||3);
  const { salt, hash } = generateSaltAndHash(bombs);
  const coeffs = getRates(presetValue||3);
  return {
    id, state:'Active', bet:amount, hash, salt, lastRound:0, coefficient:0, availableCashout:0,
    startDate:new Date().toISOString(), endDate:'', currency:Store.user.currency,
    gameData:{ presetValue:presetValue||3, coefficients:coeffs, userChoices:[], expectedChoices, currentRoundId:0, rounds:[{id:0,amount:0,availableCash:0,odd:1}] },
    _internal:{ bombs }
  };
}
function finishRound(session, click){
  const key = `${click.col},${click.row}`; const isBomb = session._internal.bombs.has(key);
  const next = session.lastRound + 1; const coeff = session.gameData.coefficients[Math.max(0,next-1)] || session.coefficient || 0;
  session.gameData.userChoices.push({ value:{col:click.col,row:click.row}, category: isBomb?1:0 });
  session.lastRound = next; session.coefficient = isBomb ? session.coefficient : coeff;
  // advance round counters/rounds list
  session.gameData.currentRoundId = next;
  session.gameData.rounds.push({ id: next, amount: session.bet, availableCash: Math.round(session.bet * (isBomb? session.coefficient : coeff)), odd: session.coefficient });
  if (isBomb) { 
    session.state='Loss'; 
    session.availableCashout=0; 
    session.endDate=new Date().toISOString(); 
    // Don't immediately clear - let the response go through first, then clear on next API call
  }
  else { 
    session.availableCashout = Math.round(session.bet * session.coefficient); 
    if (next>=session.gameData.coefficients.length){ 
      session.state='Win'; 
      session.endDate=new Date().toISOString(); 
      // Auto-credit balance for full win (all fields opened)
      if (!session._internal.paid) {
        Store.user.balance = Math.round((Store.user.balance + session.availableCashout) * 100) / 100;
        session._internal.paid = true;
        // Send real-time balance update
        sendSSEToAll({ type: 'balance_update', balance: Store.user.balance, currency: Store.user.currency });
      }
    } 
  }
}
function cashout(){ const s=Store.activeSession; if(!s) return; if(s.state==='Active'&&s.availableCashout>0){ Store.user.balance+=s.availableCashout; s.state='Win'; s.endDate=new Date().toISOString(); } Store.history.unshift(publicSession(s)); Store.activeSession=null; }
// persist after cashout
const _origCashout = cashout;
cashout = function(){
  // rebind to persist
  const s = Store.activeSession;
  if(!s) return;
  if(s.state==='Active'&&s.availableCashout>0){ 
    Store.user.balance = Math.round((Store.user.balance + s.availableCashout) * 100) / 100; 
    s.state='Win'; 
    s.endDate=new Date().toISOString(); 
    // Send real-time balance update
    sendSSEToAll({ type: 'balance_update', balance: Store.user.balance, currency: Store.user.currency });
  }
  Store.history.unshift(publicSession(s));
  Store.activeSession = null;
  saveHistoryToDisk();
};
function publicSession(s){ if(!s) return {}; const {_internal,...rest}=s; return rest; }

// -------- API handler (always returns a Promise<boolean>) --------
function handleApi(req,res){
  return new Promise((resolve) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname; const m = req.method;
    // Ensure any finished session is archived before answering any API call
    archiveAndClearIfFinished();
    const isApi = (p==='/mines/user'&&m==='GET')||(p==='/mines/settings'&&m==='GET')||(p==='/mines/sessions'&&m==='GET')||(p==='/mines/session'&&m==='POST')||(p==='/mines/round'&&m==='PUT')||(p==='/mines/debug/state'&&m==='GET')||(p==='/mines/debug/topup'&&(m==='POST'||m==='OPTIONS'))||(/^\/mines\/session\//.test(p)&&['GET','PUT'].includes(m));
    if(/^\/mines\/session\/[A-Za-z0-9_-]+$/.test(p) && m==='GET'){
      const id = p.split('/').pop();
      if (Store.activeSession && Store.activeSession.id === id) {
        send(res,200,publicSession(Store.activeSession),{ 'Content-Type':'application/json' });
        return resolve(true);
      }
      const found = Store.history.find(s=>s.id===id);
      if (found) { send(res,200,found,{ 'Content-Type':'application/json' }); return resolve(true); }
      send(res,404,{ error:{ type:'notFound' } },{ 'Content-Type':'application/json' });
      return resolve(true);
    }
    if(p==='/mines/debug/state'&&m==='GET'){
      archiveAndClearIfFinished();
      const s = Store.activeSession;
      if(!s){
        const payload = {
          sessionId: Store.user.sessionId || null,
          lastRound: 0,
          bombs: [],
          revealed: [],
          safe: [],
          balance: Store.user.balance,
          currency: Store.user.currency,
          minesLeft: null
        };
        send(res,200,payload,{ 'Content-Type':'application/json' });
        return resolve(true);
      }
      const bombsList = [];
      try {
        s._internal.bombs.forEach(k=>{ const parts = String(k).split(','); bombsList.push({ col:Number(parts[0]), row:Number(parts[1]) }); });
      } catch {}
      const revealedList = (s.gameData.userChoices||[]).map(c=>({ col:c.value.col, row:c.value.row }));
      const safeList = (s.gameData.expectedChoices||[]).filter(e=>e && e.category===0 && e.value).map(e=>({ col:e.value.col, row:e.value.row }));
      const payload = {
        sessionId: s.id,
        lastRound: s.lastRound,
        bombs: bombsList,
        revealed: revealedList,
        safe: safeList,
        balance: Store.user.balance,
        currency: Store.user.currency,
        minesLeft: (s._internal && s._internal.bombs && typeof s._internal.bombs.size==='number') ? s._internal.bombs.size : null
      };
      send(res,200,payload,{ 'Content-Type':'application/json' });
      return resolve(true);
    }
    if(!isApi) return resolve(false);
    if(p==='/mines/debug/topup'&&m==='OPTIONS'){
      send(res,204,'',{ 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type' });
      return resolve(true);
    }
    if(p==='/mines/user'&&m==='GET'){ archiveAndClearIfFinished(); send(res,200,Store.user,{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); return resolve(true); }
    if(p==='/mines/sse'&&m==='GET'){
      // Server-Sent Events endpoint for real-time balance updates
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });
      
      // Send initial balance
      res.write(`data: ${JSON.stringify({ type: 'balance_update', balance: Store.user.balance, currency: Store.user.currency })}\n\n`);
      
      // Add client to SSE clients set
      Store.sseClients.add(res);
      
      // Remove client when connection closes
      req.on('close', () => {
        Store.sseClients.delete(res);
      });
      
      return resolve(true);
    }
    if(p==='/mines/settings'&&m==='GET'){ send(res,200,Store.settings,{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); return resolve(true); }
    if(p==='/mines/debug/topup'&&m==='POST'){
      readJson(req, body=>{
        const amount = Number(body.amount||0);
        const max = 20000;
        if(!Number.isFinite(amount) || amount<=0){ send(res,400,{ error:{ type:'badAmount', message:'Amount must be positive number' }},{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); return resolve(true);} 
        if(amount>max){ send(res,400,{ error:{ type:'tooHigh', message:`Max topup is ${max}` }},{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); return resolve(true);} 
        const before = Store.user.balance;
        Store.user.balance = Math.round((Store.user.balance + amount)*100)/100;
        const delta = Math.round((Store.user.balance - before)*100)/100;
        send(res,200,{ ok:true, credited: delta, balance: Store.user.balance, currency: Store.user.currency },{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
        // Send real-time balance update to all connected clients
        sendSSEToAll({ type: 'balance_update', balance: Store.user.balance, currency: Store.user.currency });
        return resolve(true);
      });
      return; // will resolve in callback
    }
    if(p==='/mines/sessions'&&m==='GET'){
      // Always return history (used for "My" tab). Auto-restore is prevented elsewhere.
      send(res,200,{ limit:30, offset:0, data:Store.history.slice(0,30) },{ 'Content-Type':'application/json' });
      return resolve(true);
    }
    if(p==='/mines/session'&&m==='POST'){
      readJson(req, body=>{
        const amount=Number(body.amount||0), preset=Number(body.presetValue||3);
        const qb = Store.settings.bets[Store.user.currency]?.quickBets || { min:1,max:100 };
        // If there is a finished session lingering (Loss/Win), archive and clear it to allow new game
        if (Store.activeSession && Store.activeSession.state !== 'Active') {
          const ended = publicSession(Store.activeSession);
          if (!Store.history.find(s=>s.id===ended.id)) { Store.history.unshift(ended); saveHistoryToDisk(); }
          Store.activeSession = null;
          Store.user.sessionId = null;
        }
        if(amount<qb.min) { send(res,400,{ error:{ type:'smallBid', header:'Rate below the minimum', message:'Rate below the minimum' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(amount>qb.max) { send(res,400,{ error:{ type:'highBid', header:'Rate above the maximum', message:'Rate above the maximum' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(amount>Store.user.balance) { send(res,400,{ error:{ type:'insufficientFunds', header:'Insufficient funds', message:'Insufficient funds' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(Store.activeSession) { send(res,400,{ error:{ type:'activeSessionExists', header:'Active session already exists', message:'Active session already exists' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        Store.user.balance -= amount; Store.activeSession = buildSession(amount, preset);
        Store.user.sessionId = Store.activeSession.id;
        send(res,200,publicSession(Store.activeSession),{ 'Content-Type':'application/json' });
        return resolve(true);
      });
      return; // will resolve in callback
    }
    if(p==='/mines/round'&&m==='PUT'){
      readJson(req, body=>{
        if(!Store.activeSession) {
          // When no active session, hard return neutral but consistent payload
          const neutral = {
            userChoices: [],
            state: 'Not started',
            availableCashout: 0,
            coefficient: 0,
            lastRound: 0,
            gameData: {
              currentRoundId: 0,
              availableCashout: false,
              rounds: [],
              coefficients: [],
              expectedChoices: []
            }
          };
          send(res,200,neutral,{ 'Content-Type':'application/json' });
          return resolve(true);
        }
        const click={ col:Number(body.col), row:Number(body.row) };
        const dup = Store.activeSession.gameData.userChoices.some(c=>c.value.col===click.col&&c.value.row===click.row);
        if(dup) { send(res,400,{ error:{ type:'duplicateRound', message:'Round with this column and row already exists' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        finishRound(Store.activeSession, click);
        const s = Store.activeSession;
        const payload = {
          userChoices: s.gameData.userChoices,
          state: s.state,
          availableCashout: s.availableCashout || 0,
          coefficient: s.coefficient || 0,
          lastRound: s.lastRound || 0,
          gameData: {
            currentRoundId: s.gameData.currentRoundId,
            availableCashout: s.availableCashout > 0,
            rounds: s.gameData.rounds,
            coefficients: s.gameData.coefficients,
            expectedChoices: s.gameData.expectedChoices
          }
        };
        send(res,200,payload,{ 'Content-Type':'application/json' });
        return resolve(true);
      });
      return; // will resolve in callback
    }
    if(/^\/mines\/session\//.test(p)&&m==='PUT'){ cashout(); send(res,200,Store.history[0]||{},{ 'Content-Type':'application/json' }); return resolve(true); }
    return resolve(false);
  });
}

const server = http.createServer(async (req,res)=>{
  try{
    const urlPath = req.url || '/';

    // Redirect root to mines game
    if (urlPath === '/' || urlPath === '/index.html') {
      return send(res, 302, '', { Location: '/mines/' });
    }

    // Minimal manifest
    if (urlPath === '/manifest.json') {
      return send(res,200,{ name:'1WIN', short_name:'1WIN', start_url:'/mines/', display:'standalone', icons:[] },{ 'Content-Type':'application/manifest+json' });
    }
    // Health/probe files from wrapper
    if (urlPath.startsWith('/1.txt')) return send(res,200,'ok',{ 'Content-Type':'text/plain; charset=utf-8' });
    if (urlPath === '/sw.9624630e.js') return send(res,200,'// noop',{ 'Content-Type':'application/javascript; charset=utf-8' });
    // Service worker mock (optional)
    if (urlPath === '/mines/mock-sw.js') {
      const p = path.join(ROOT,'prod-rnd-frontend-php-orchestra.100hp.app','mines','mock-sw.js');
      if (fs.existsSync(p)) return send(res,200,fs.readFileSync(p),{ 'Content-Type':'application/javascript; charset=utf-8' });
      return send(res,200,'// no sw',{ 'Content-Type':'application/javascript; charset=utf-8' });
    }

    // Serve Mines app normally (no predictor page on 8080)

    // No external proxy: serve only local assets and Mines API

    // Local API (works even without SW)
    if (urlPath.startsWith('/mines')) {
      const handled = await handleApi(req,res); if (handled) return;
    }

    // Map asset root used by bundle
    let pth = urlPath;
    if (pth.startsWith('/static/')) pth = path.posix.join('/prod-rnd-frontend-php-orchestra.100hp.app', pth);
    if (pth === '/favicon.svg') pth = path.posix.join('/prod-rnd-frontend-php-orchestra.100hp.app', pth);

    // Static serving
    const resolved = safeResolve(pth);
    if (!resolved) return send(res,403,'Forbidden');
    let filePath = resolved;
    if (pth.endsWith('/')) { const idx=path.join(resolved,'index.html'); if (fs.existsSync(idx)) filePath=idx; }
    if (!fs.existsSync(filePath)) {
      // Synthesize missing chunks so app doesn't hard-crash
      const m = /static\/js\/([0-9]+)\.[A-Za-z0-9]+\.chunk\.js$/.exec(pth);
      if (m) {
        const id = m[1];
        const code = `;(self.webpackChunkcoin_flip_app_ts=self.webpackChunkcoin_flip_app_ts||[]).push([[${id}],{${id}:(m)=>{m.exports={};}}]);`;
        return send(res,200,code,{ 'Content-Type':'application/javascript; charset=utf-8', 'Cache-Control':'no-store' });
      }
      if (fs.existsSync(filePath + '.html')) filePath = filePath + '.html';
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      const minesIndex = path.join(ROOT,'prod-rnd-frontend-php-orchestra.100hp.app','mines','index.html');
      if (fs.existsSync(minesIndex)) return send(res,200,fs.readFileSync(minesIndex),{ 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
      return send(res,404,'Not Found');
    }

    const ct = contentType(filePath);
    const noCache = /\.(?:html|js)$/.test(filePath);
    const headers = { 'Content-Type': ct, 'Cache-Control': noCache ? 'no-store' : 'public, max-age=31536000, immutable' };
    // Inject runtime translation for Mines index
    if (/html/.test(ct) && /prod-rnd-frontend-php-orchestra\.100hp\.app[\\\/]mines[\\\/]index\.html$/.test(filePath)) {
      let html = fs.readFileSync(filePath,'utf8');
      const inject = `<script>(function(){try{
        // Order matters to avoid partial overlaps (HowToPlay before Play)
        const rules=[
          {re:/\bHowToPlay\b/g, to:'Как играть'},
          {re:/(^|\s)Play(\s|$)/g, to:'$1Играть$2'},
          {re:/\bMy\b/g, to:'Мои'},
          {re:/\bPlayer\b/g, to:'Игрок'},
          {re:/\bBet\b/g, to:'Ставка'},
          {re:/\bCoef\b/g, to:'Коэф'},
          {re:/\bWin\b/g, to:'Выигрыш'},
          {re:/\bTraps\b/g, to:'Ловушки'},
          {re:/\bYourWinnings\b/g, to:'Ваш выигрыш'},
          {re:/\bNextStep\b/g, to:'След. шаг'},
          {re:/\bTakeMoney\b/g, to:'Забрать'},
          {re:/\bYouWon\b/g, to:'Вы выиграли'}
        ];
        function trText(t){ if(!t) return t; if(/\bLive\b/.test(t) || /CAVEMINES/.test(t)) return t; let out=t; for(const {re,to} of rules){ out=out.replace(re,to);} return out; }
        function trNode(n){ if(n.nodeType===Node.TEXT_NODE){ n.nodeValue=trText(n.nodeValue); } else if(n.nodeType===Node.ELEMENT_NODE){ if(n.childNodes&&n.childNodes.length===1&&n.firstChild.nodeType===Node.TEXT_NODE){ n.textContent=trText(n.textContent);} } }
        function run(){ try{ const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null); let node; while(node=w.nextNode()){ trNode(node);} document.querySelectorAll('button,span,div,li,th,strong,b').forEach(trNode);}catch(_){} }
        run(); new MutationObserver(run).observe(document.body,{childList:true,subtree:true,characterData:true});
      }catch(_){}})();</script>`;
      
      // SSE for real-time balance updates
      const sseScript = `<script>(function(){
        // Connect to SSE for real-time balance updates
        const eventSource = new EventSource('/mines/sse');
        
        // Function to force React re-render by intercepting fetch calls
        let currentBalance = 1000; // Default balance
        
        function forceReactUpdate(newBalance) {
          currentBalance = newBalance;
          // Method 1: Update all balance elements directly
          const balanceSelectors = [
            '[data-testid="balance"]',
            '.balance',
            '[class*="balance"]',
            '[class*="Balance"]',
            '[class*="user-balance"]',
            '[class*="userBalance"]',
            'span:contains("₽")',
            'span:contains("RUB")'
          ];
          
          balanceSelectors.forEach(selector => {
            try {
              const elements = document.querySelectorAll(selector);
              elements.forEach(el => {
                if (el.textContent && (el.textContent.includes('₽') || el.textContent.includes('RUB'))) {
                  el.textContent = newBalance.toLocaleString('ru-RU') + ' ₽';
                  // Trigger input event to notify React
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                }
              });
            } catch (e) {}
          });
          
          // Method 2: Intercept fetch calls to /mines/user and return updated balance
          const originalFetch = window.fetch;
          window.fetch = function(...args) {
            const [url, options] = args;
            if (typeof url === 'string' && url.includes('/mines/user')) {
              return originalFetch.apply(this, args).then(response => {
                if (response.ok) {
                  return response.clone().json().then(data => {
                    data.balance = currentBalance;
                    return new Response(JSON.stringify(data), {
                      status: 200,
                      headers: response.headers
                    });
                  });
                }
                return response;
              });
            }
            return originalFetch.apply(this, args);
          };
          
          // Method 2.5: Intercept XMLHttpRequest for older code
          const originalXHROpen = XMLHttpRequest.prototype.open;
          const originalXHRSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method, url, ...args) {
            this._url = url;
            return originalXHROpen.apply(this, [method, url, ...args]);
          };
          XMLHttpRequest.prototype.send = function(...args) {
            if (this._url && this._url.includes('/mines/user')) {
              this.addEventListener('readystatechange', function() {
                if (this.readyState === 4 && this.status === 200) {
                  try {
                    const data = JSON.parse(this.responseText);
                    data.balance = currentBalance;
                    Object.defineProperty(this, 'responseText', {
                      value: JSON.stringify(data),
                      writable: false
                    });
                  } catch (e) {}
                }
              });
            }
            return originalXHRSend.apply(this, args);
          };
          
          // Method 3: Force React to re-render by dispatching custom events
          document.dispatchEvent(new CustomEvent('balance-updated', { 
            detail: { balance: newBalance, currency: 'RUB' } 
          }));
          
          // Method 4: Try to find React root and force update
          setTimeout(() => {
            const root = document.getElementById('root');
            if (root && root._reactInternalFiber) {
              // Force React to re-render by changing a data attribute
              root.setAttribute('data-balance', newBalance);
              root.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, 50);
          
          // Method 5: Update any localStorage or sessionStorage that might be used
          try {
            localStorage.setItem('user_balance', newBalance.toString());
            sessionStorage.setItem('user_balance', newBalance.toString());
          } catch (e) {}
          
          // Method 6: Set up periodic DOM scanning for new balance elements
          clearInterval(window._balanceUpdateInterval);
          window._balanceUpdateInterval = setInterval(() => {
            const allElements = document.querySelectorAll('*');
            allElements.forEach(el => {
              if (el.textContent && (el.textContent.includes('₽') || el.textContent.includes('RUB'))) {
                const text = el.textContent;
                const balanceMatch = text.match(/(\d+(?:,\d{3})*)\s*[₽RUB]/);
                if (balanceMatch && !el._balanceUpdated) {
                  el.textContent = text.replace(balanceMatch[0], newBalance.toLocaleString('ru-RU') + ' ₽');
                  el._balanceUpdated = true;
                }
              }
            });
          }, 1000);
        }
        
        eventSource.onmessage = function(event) {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'balance_update') {
              console.log('SSE: Balance updated to', data.balance);
              forceReactUpdate(data.balance);
            }
          } catch (e) {
            console.log('SSE parse error:', e);
          }
        };
        
        eventSource.onerror = function() {
          console.log('SSE connection error, retrying...');
          setTimeout(() => {
            eventSource.close();
            location.reload();
          }, 5000);
        };
        
        // Also listen for balance updates from other sources
        window.addEventListener('balance-updated', function(e) {
          if (e.detail && e.detail.balance) {
            forceReactUpdate(e.detail.balance);
          }
        });
        
        // Initialize: Get current balance on page load
        fetch('/mines/user')
          .then(response => response.json())
          .then(data => {
            if (data.balance) {
              currentBalance = data.balance;
              forceReactUpdate(data.balance);
            }
          })
          .catch(e => console.log('Failed to get initial balance:', e));
        
      })();</script>`;
      
      html = html.replace(/<\/body>/i, inject + sseScript + '</body>');
      return send(res,200,html,headers);
    }
    if (/javascript/.test(ct)) {
      let txt = fs.readFileSync(filePath,'utf8');
      // Keep websocket origin intact to allow real Live feed
      txt = txt.replace(/https:\/\/prod-rnd-backend-php-orchestra\.100hp\.app/g,'');
      // UI ru localization (safe DOM-text replacements). Keep CaveMines and Live, but translate My -> Мои
      txt = txt.replace(/>My</g, '>Мои<');
      txt = txt.replace(/>Player</g, '>Игрок');
      txt = txt.replace(/>Bet</g, '>Ставка');
      txt = txt.replace(/>Coef</g, '>Коэф');
      txt = txt.replace(/>Win</g, '>Выигрыш');
      txt = txt.replace(/>HowToPlay</g, '>Как играть');
      // Button label Play (avoid HowToPlay)
      txt = txt.replace(/>(\s*)Play(\s*)</g, '>$1Играть$2<');
      // Traps label
      txt = txt.replace(/>Traps</g, '>Ловушки');
      return send(res,200,Buffer.from(txt,'utf8'),headers);
    }
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, headers);
    stream.pipe(res);
    stream.on('error', () => {
      if (!res.headersSent) return send(res,500,'Internal Server Error');
      try { res.destroy(); } catch {}
    });
  }catch(e){
    console.error('[server] 500', e && e.message);
    if (!res.headersSent) return send(res,500,'Internal Server Error');
    try { res.end(); } catch {}
    return;
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/mines/`;
  console.log(`[server] listening on ${PORT}`);
  console.log(`[server] open: ${url}`);
  try { exec(`start "" "${url}"`); } catch {}
});


