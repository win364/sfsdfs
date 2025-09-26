// Vercel Serverless Function entry - only handles API requests
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.cwd();

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  if (Buffer.isBuffer(body) || typeof body === 'string') return res.end(body);
  if (body == null) return res.end();
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
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
  sseClients: new Set(),
  settings: (() => {
    try {
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.join(process.cwd(), 'prod-rnd-backend-php-orchestra.100hp.app', 'mines', 'settings.html');
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      return {
        supportedCurrencies: ['RUB'],
        bets: { RUB: { quickBets: { min: 5, max: 9999 }, defaultBet: 50, steps: [] } },
        presets: [{ presetValue: 3, isDefault: true }],
        rates: [{ presetValue: 3, rates: [1.09,1.24,1.43,1.65,1.93,2.27,2.69,3.23,3.92] }],
        roundsCount: 25,
      };
    }
  })(),
  activeSession: null,
  history: [],
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
  session.gameData.currentRoundId = next;
  session.gameData.rounds.push({ id: next, amount: session.bet, availableCash: Math.round(session.bet * (isBomb? session.coefficient : coeff)), odd: session.coefficient });
  if (isBomb) { 
    session.state='Loss'; 
    session.availableCashout=0; 
    session.endDate=new Date().toISOString(); 
  }
  else { 
    session.availableCashout = Math.round(session.bet * session.coefficient); 
    if (next>=session.gameData.coefficients.length){ 
      session.state='Win'; 
      session.endDate=new Date().toISOString(); 
      if (!session._internal.paid) {
        Store.user.balance = Math.round((Store.user.balance + session.availableCashout) * 100) / 100;
        session._internal.paid = true;
      }
    } 
  }
}

function cashout(){ 
  const s=Store.activeSession; 
  if(!s) return; 
  if(s.state==='Active'&&s.availableCashout>0){ 
    Store.user.balance = Math.round((Store.user.balance + s.availableCashout) * 100) / 100; 
    s.state='Win'; 
    s.endDate=new Date().toISOString(); 
  }
  Store.history.unshift(publicSession(s));
  Store.activeSession = null;
}

function publicSession(s){ if(!s) return {}; const {_internal,...rest}=s; return rest; }

// Update balance like in server.js
function updateBalance(amount) {
  Store.user.balance = Math.round((Store.user.balance + amount) * 100) / 100;
  return Store.user.balance;
}

// -------- API handler --------
function handleApi(req,res){
  return new Promise((resolve) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname; const m = req.method;
    
    // Only handle API endpoints
    if(p==='/mines/user'&&m==='GET'){ 
      // Return user with current balance
      const userData = {
        language: 'ru',
        currency: 'RUB',
        sessionId: Store.user.sessionId,
        balance: Store.user.balance,
        name: 'Player',
        avatar: '',
        exchangeRate: 1
      };
      console.log('[API] User data:', userData);
      send(res,200,userData,{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); 
      return resolve(true); 
    }
    
    if(p==='/mines/settings'&&m==='GET'){ 
      send(res,200,Store.settings,{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); 
      return resolve(true); 
    }
    
    if(p==='/mines/sessions'&&m==='GET'){
      send(res,200,{ limit:30, offset:0, data:Store.history.slice(0,30) },{ 'Content-Type':'application/json' });
      return resolve(true);
    }
    
    if(p==='/mines/session'&&m==='POST'){
      readJson(req, body=>{
        const amount=Number(body.amount||0), preset=Number(body.presetValue||3);
        const qb = Store.settings.bets[Store.user.currency]?.quickBets || { min:1,max:100 };
        
        if(amount<qb.min) { send(res,400,{ error:{ type:'smallBid', header:'Rate below the minimum', message:'Rate below the minimum' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(amount>qb.max) { send(res,400,{ error:{ type:'highBid', header:'Rate above the maximum', message:'Rate above the maximum' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(amount>Store.user.balance) { send(res,400,{ error:{ type:'insufficientFunds', header:'Insufficient funds', message:'Insufficient funds' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(Store.activeSession) { send(res,400,{ error:{ type:'activeSessionExists', header:'Active session already exists', message:'Active session already exists' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        
        Store.user.balance = Math.round((Store.user.balance - amount) * 100) / 100;
        Store.activeSession = buildSession(amount, preset);
        Store.user.sessionId = Store.activeSession.id;
        send(res,200,publicSession(Store.activeSession),{ 'Content-Type':'application/json' });
        return resolve(true);
      });
      return;
    }
    
    if(p==='/mines/round'&&m==='PUT'){
      readJson(req, body=>{
        if(!Store.activeSession) {
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
      return;
    }
    
    if(/^\/mines\/session\//.test(p)&&m==='PUT'){ 
      cashout(); 
      send(res,200,Store.history[0]||{},{ 'Content-Type':'application/json' }); 
      return resolve(true); 
    }
    
    // If not an API endpoint, return 404
    send(res,404,'API endpoint not found');
    return resolve(true);
  });
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }
    
    // Handle API requests and serve the game
    if (p.startsWith('/mines/')) {
      // If it's a specific API endpoint, handle it
      if (p.includes('/mines/user') || p.includes('/mines/settings') || p.includes('/mines/session') || p.includes('/mines/round')) {
        await handleApi(req, res);
      } else {
        // Serve the game HTML for /mines/ requests
        const fs = require('fs');
        const path = require('path');
        try {
          const gameHtml = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
          send(res, 200, gameHtml, { 'Content-Type': 'text/html; charset=utf-8' });
        } catch (error) {
          send(res, 500, 'Game not found');
        }
      }
    } else {
      send(res,404,'Not found');
    }
  } catch (e) {
    console.error('[API] Error:', e);
    send(res,500,'Internal Server Error');
  }
};


