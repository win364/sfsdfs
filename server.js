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

// -------- Local API store --------
const Store = {
  user: { language: 'ru', currency: 'RUB', sessionId: null, balance: 1000.00, name: 'Player', avatar: '', exchangeRate: 1 },
  // SSE clients for real-time balance updates
  sseClients: new Set(),
  settings: (() => {
    try {
      const p = path.join(ROOT, 'prod-rnd-backend-php-orchestra.100hp.app', 'mines', 'settings.html');
      const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Force RUB currency and settings
      return {
        ...settings,
        supportedCurrencies: ['RUB'],
        bets: { RUB: { quickBets: { min: 1, max: 20000 }, defaultBet: 100, steps: [] } },
        presets: [{ presetValue: 3, isDefault: true }],
        rates: [{ presetValue: 3, rates: [1.09,1.24,1.43,1.65,1.93,2.27,2.69,3.23,3.92] }],
        roundsCount: 25,
      };
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
  history: (() => {
    try {
      const raw = fs.readFileSync(HISTORY_FILE,'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.data)) {
        return parsed.data;
      }
    } catch {
      // try fallback sessions-*.html
      try {
        const dir = path.dirname(HISTORY_FILE);
        const files = fs.readdirSync(dir).filter(f=>/^sessions-.*\.html$/i.test(f));
        if (files.length){
          const raw = fs.readFileSync(path.join(dir,files[0]),'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.data)) return parsed.data;
        }
      } catch {}
    }
    return [];
  })(),
};


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

function buildSession(amount, presetValue, userData) {
  const id = Math.random().toString(36).slice(2)+Date.now().toString(36);
  const { bombs, expectedChoices } = randomBombs(presetValue||3);
  const { salt, hash } = generateSaltAndHash(bombs);
  const coeffs = getRates(presetValue||3);
  return {
    id, state:'Active', bet:amount, hash, salt, lastRound:0, coefficient:0, availableCashout:0,
    startDate:new Date().toISOString(), endDate:'', currency:userData.currency,
    gameData:{ presetValue:presetValue||3, coefficients:coeffs, userChoices:[], expectedChoices, currentRoundId:0, rounds:[{id:0,amount:0,availableCash:0,odd:1}] },
    _internal:{ bombs }
  };
}

function finishRound(session, click, userData, userId){
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
    // Move finished session to user's history
    if (!userData.history) userData.history = [];
    userData.history.unshift(publicSession(session));
    userData.activeSession = null;
    userData.sessionId = null;
  }
  else { 
    session.availableCashout = Math.round(session.bet * session.coefficient); 
    if (next>=session.gameData.coefficients.length){ 
      session.state='Win'; 
      session.endDate=new Date().toISOString(); 
      // Auto-credit balance for full win (all fields opened)
      if (!session._internal.paid) {
        userData.balance = Math.round((userData.balance + session.availableCashout) * 100) / 100;
        session._internal.paid = true;
        // Send real-time balance update
        sendSSEToAll({ type: 'balance_update', balance: userData.balance, currency: userData.currency });
      }
    } 
  }
}

function cashout(userData, userId){ 
  const s=userData.activeSession; 
  if(!s) return;
  if(s.state==='Active'&&s.availableCashout>0){ 
    userData.balance = Math.round((userData.balance + s.availableCashout) * 100) / 100; 
    s.state='Win'; 
    s.endDate=new Date().toISOString(); 
    // Send real-time balance update
    sendSSEToAll({ type: 'balance_update', balance: userData.balance, currency: userData.currency });
  }
  if (!userData.history) userData.history = [];
  userData.history.unshift(publicSession(s));
  userData.activeSession=null; 
  userData.sessionId=null;
}

function publicSession(s){ if(!s) return {}; const {_internal,...rest}=s; return rest; }

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

// Send SSE message to specific user
function sendSSEToUser(userId, data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  // Find clients for this specific user
  Store.sseClients.forEach(client => {
    if (client._userId === userId) {
      try {
        client.write(message);
      } catch (e) {
        // Remove disconnected clients
        Store.sseClients.delete(client);
      }
    }
  });
}

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

// -------- API handler --------
function handleApi(req,res){
  return new Promise((resolve) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname; const m = req.method;
    const userId = getUserId(req);
    const userData = getUserData(userId);
    
    if(p==='/mines/user'&&m==='GET'){ 
      archiveAndClearIfFinished(userData);
      send(res,200,userData,{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); 
      return resolve(true);
    }
    
    if(p==='/mines/balance'&&m==='GET'){ 
      send(res,200,{ balance: userData.balance, currency: userData.currency },{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); 
      return resolve(true);
    }
    
    if(p==='/mines/sse'&&m==='GET'){
      // Server-Sent Events endpoint for real-time balance updates
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });
      
      // Mark this client with user ID
      res._userId = userId;
      
      // Send initial balance
      res.write(`data: ${JSON.stringify({ type: 'balance_update', balance: userData.balance, currency: userData.currency })}\n\n`);
      
      // Add client to SSE clients set
      Store.sseClients.add(res);
      
      // Remove client when connection closes
      req.on('close', () => {
        Store.sseClients.delete(res);
      });
      
      return resolve(true);
    }
    
    if(p==='/mines/settings'&&m==='GET'){ 
      send(res,200,Store.settings,{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); 
        return resolve(true);
    }
    
    if(p==='/mines/sessions'&&m==='GET'){
      // Return user's personal history + global history for live feed
      const userHistory = userData.history || [];
      const combinedHistory = [...userHistory, ...Store.globalHistory].slice(0, 30);
      send(res,200,{ limit:30, offset:0, data:combinedHistory },{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
      return resolve(true);
    }
    
    if(p.startsWith('/mines/sessions')&&m==='GET'){
      // Handle sessions with query parameters - return user's history
      const userHistory = userData.history || [];
      send(res,200,{ limit:30, offset:0, data:userHistory },{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
      return resolve(true);
    }
    
    if(p==='/mines/session'&&m==='POST'){
      readJson(req, body=>{
        const amount=Number(body.amount||0), preset=Number(body.presetValue||3);
        const qb = Store.settings.bets[userData.currency]?.quickBets || { min:1,max:100 };
        
        // If there is a finished session lingering (Loss/Win), archive and clear it to allow new game
        if (userData.activeSession && userData.activeSession.state !== 'Active') {
          const ended = publicSession(userData.activeSession);
          if (!userData.history.find(s=>s.id===ended.id)) { 
            userData.history.unshift(ended); 
          }
          userData.activeSession = null;
          userData.sessionId = null;
        }
        
        if(amount<qb.min) { send(res,400,{ error:{ type:'smallBid', header:'Rate below the minimum', message:'Rate below the minimum' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(amount>qb.max) { send(res,400,{ error:{ type:'highBid', header:'Rate above the maximum', message:'Rate above the maximum' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(amount>userData.balance) { send(res,400,{ error:{ type:'insufficientFunds', header:'Insufficient funds', message:'Insufficient funds' }},{ 'Content-Type':'application/json' }); return resolve(true);}
        if(userData.activeSession) { send(res,400,{ error:{ type:'activeSessionExists', header:'Active session already exists', message:'Active session already exists' }},{ 'Content-Type':'application/json' }); return resolve(true);}
        userData.balance -= amount; 
        userData.activeSession = buildSession(amount, preset, userData);
        userData.sessionId = userData.activeSession.id;
        send(res,200,publicSession(userData.activeSession),{ 'Content-Type':'application/json' });
        return resolve(true);
      });
      return;
    }
    
    if(p==='/mines/round'&&m==='PUT'){
      readJson(req, body=>{
        if(!userData.activeSession) {
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
        const dup = userData.activeSession.gameData.userChoices.some(c=>c.value.col===click.col&&c.value.row===click.row);
        if(dup) { send(res,400,{ error:{ type:'duplicateRound', message:'Round with this column and row already exists' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        const sessionBefore = userData.activeSession;
        finishRound(userData.activeSession, click, userData, userId);
        
        // If session was finished (bomb hit), return the finished session
        if (!userData.activeSession && sessionBefore) {
          const finishedSession = publicSession(sessionBefore);
          const payload = {
            userChoices: finishedSession.gameData.userChoices,
            state: finishedSession.state,
            availableCashout: 0,
            coefficient: finishedSession.coefficient || 0,
            lastRound: finishedSession.lastRound || 0,
            gameData: {
              currentRoundId: finishedSession.gameData.currentRoundId,
              availableCashout: false,
              rounds: finishedSession.gameData.rounds,
              coefficients: finishedSession.gameData.coefficients,
              expectedChoices: finishedSession.gameData.expectedChoices
            }
          };
          send(res,200,payload,{ 'Content-Type':'application/json' });
          return resolve(true);
        }
        
        // If session is still active, return current state
        const s = userData.activeSession;
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
      return;
    }
    
    if(/^\/mines\/session\//.test(p)&&m==='PUT'){ 
      cashout(userData, userId); 
      send(res,200,userData.history?.[0]||{},{ 'Content-Type':'application/json' }); 
      return resolve(true); 
    }
    
    if(p==='/mines/cashout'&&m==='POST'){
      if(!userData.activeSession) {
        send(res,400,{ error:{ type:'noActiveSession', message:'No active session to cashout' }},{ 'Content-Type':'application/json' });
        return resolve(true);
      }
      if(userData.activeSession.availableCashout <= 0) {
        send(res,400,{ error:{ type:'noCashoutAvailable', message:'No cashout available' }},{ 'Content-Type':'application/json' });
        return resolve(true);
      }
      cashout(userData, userId);
      send(res,200,{ success: true, balance: userData.balance },{ 'Content-Type':'application/json' });
      return resolve(true);
    }
    
    if(p==='/mines/debug/state'&&m==='GET'){
      const debug = {
        user: userData,
        activeSession: userData.activeSession ? {
          id: userData.activeSession.id,
          state: userData.activeSession.state,
          coefficient: userData.activeSession.coefficient,
          availableCashout: userData.activeSession.availableCashout,
          lastRound: userData.activeSession.lastRound,
          coefficients: userData.activeSession.gameData?.coefficients,
          userChoices: userData.activeSession.gameData?.userChoices
        } : null
      };
      send(res,200,debug,{ 'Content-Type':'application/json' });
      return resolve(true);
    }
    
    if(p==='/mines/debug/topup'&&m==='POST'){
      readJson(req, body=>{
        const amount = Number(body.amount||0);
        const max = 20000;
        if(!Number.isFinite(amount) || amount<=0){ 
          send(res,400,{ error:{ type:'badAmount', message:'Amount must be positive number' }},{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); 
          return resolve(true);
        } 
        if(amount>max){ 
          send(res,400,{ error:{ type:'tooHigh', message:`Max topup is ${max}` }},{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); 
          return resolve(true);
        } 
        const before = userData.balance;
        userData.balance = Math.round((userData.balance + amount)*100)/100;
        const delta = Math.round((userData.balance - before)*100)/100;
        send(res,200,{ ok:true, credited: delta, balance: userData.balance, currency: userData.currency },{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
        // Send real-time balance update to this specific user
        sendSSEToUser(userId, { type: 'balance_update', balance: userData.balance, currency: userData.currency });
        return resolve(true);
      });
      return;
    }
    
    send(res,404,'API endpoint not found');
    return resolve(true);
  });
}

// Main handler
async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    
    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }
    
    // Handle static files
    if (p.startsWith('/static/') || p === '/favicon.svg' || p === '/manifest.json') {
      try {
        const filePath = path.join(process.cwd(), 'public', p);
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath);
          const contentType = {
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.woff2': 'font/woff2',
            '.woff': 'font/woff',
            '.mp3': 'audio/mpeg',
            '.json': 'application/json'
          }[ext] || 'application/octet-stream';
          
          const content = fs.readFileSync(filePath);
          send(res, 200, content, { 'Content-Type': contentType });
        } else {
          // For missing JS chunks, return empty module to prevent errors
          if (p.includes('.chunk.js')) {
            send(res, 200, '// Empty chunk', { 'Content-Type': 'application/javascript' });
          } else if (p.includes('.woff2') || p.includes('.woff')) {
            // For missing fonts, return empty response
            send(res, 200, '', { 'Content-Type': 'font/woff2' });
          } else {
            send(res, 404, 'File not found');
          }
        }
      } catch (error) {
        send(res, 500, 'Error reading file');
      }
    } else if (p.startsWith('/socket.io/')) {
      // Handle socket.io requests
      send(res, 200, '{}', { 'Content-Type': 'application/json' });
    } else if (p.startsWith('/mines/')) {
      if (p.includes('/mines/user') || p.includes('/mines/settings') || p.includes('/mines/session') || p.includes('/mines/round') || p.includes('/mines/sessions')) {
        await handleApi(req, res);
      } else {
        try {
          const gameHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
          send(res, 200, gameHtml, { 'Content-Type': 'text/html; charset=utf-8' });
        } catch (error) {
          send(res, 500, 'Game not found');
        }
      }
    } else if (p === '/' || p === '/index.html') {
      res.writeHead(302, { Location: '/mines/' });
      res.end();
    } else {
      send(res,404,'Not found');
    }
  } catch (e) {
    console.error('Error:', e);
    send(res,500,'Internal Server Error');
  }
}

module.exports = requestHandler;