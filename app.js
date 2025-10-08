// ===== 工具 =====
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const shuffle = a => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
const pickRandom = (items,n)=> shuffle(items.slice()).slice(0, Math.min(n, items.length));
const getSubject = ()=> (new URLSearchParams(location.search).get('subject')||'').toLowerCase().trim();
const isResultsPage = () => /results\.html$/i.test(location.pathname);

// 固定題數
const FIXED_COUNT = { basic: 20, pro: 40 };

// 章節/題號字串 (只給結果頁用)
function fmtMeta(q){
  const parts = [];
  if (q.chapter != null) {
    parts.push(`第 ${q.chapter} 章${q.chapterTitle ? ` - ${q.chapterTitle}` : ''}`);
  } else if (q.chapterTitle) {
    parts.push(q.chapterTitle);
  }
  if (q.no != null) parts.push(`第 ${q.no} 題`);
  return parts.length ? `（${parts.join('，')}）` : '';
}

// ===== 狀態 =====
let bank = [];      // 題庫
let paper = [];     // 本卷抽題
let idx = 0;        // 目前題目 index
let answers = {};   // { [qid]: number }  (未作答則沒有 key)
let locked = false; // 交卷後鎖定

// ===== 入口：根據頁面分流 =====
document.addEventListener('DOMContentLoaded', () => {
  if (isResultsPage()) { renderResultsPage(); return; }

  const subject = getSubject();
  if (!subject) return; // 沒參數就顯示首頁（你的 index.html）

  const fixedN = FIXED_COUNT[subject] ?? 10;

  // 作答版面
  const main = document.querySelector('main.wrap') || document.body;
  main.innerHTML = `
    <section class="hero" style="text-align:left">
      <div class="tagline">🧪 作答模式 · 科目：<span class="kbd">${subject}</span></div>
      <h1>開始測驗</h1>
      <p class="muted" style="text-align:center">本卷固定 <span class="kbd">${fixedN}</span> 題。交卷前可自由切換題目並修改答案；交卷後跳到結果頁。</p>
    </section>

    <section class="card">
      <div class="row" style="align-items:center; gap:12px">
        <span class="kbd">題數：${fixedN}</span>
        <button id="reshuffleBtn" class="btn btn--ghost"   style="min-width:auto">重新抽題</button>
        <a class="btn" href="index.html" style="min-width:auto">← 返回首頁</a>
      </div>
    </section>

    <section id="quiz" class="quiz card" style="margin-top:12px"></section>

    <!-- 導覽列：中間=上一/下一題；右邊=交卷 -->
    <div class="nav-qa">
      <div class="nav-qa__center">
        <button id="prevBtn" class="btn btn--ghost" style="min-width:120px">上一題</button>
        <button id="nextBtn" class="btn btn--ghost" style="min-width:120px">下一題</button>
      </div>
      <div class="nav-qa__right">
        <button id="submitBtn" class="btn btn--primary" style="min-width:120px" disabled title="還有未作答的題目">交卷</button>
      </div>
    </div>

    <section class="card" style="margin-top:12px">
      <div class="pager" id="pager"></div>
    </section>
  `;

  boot(subject, fixedN);
});

// ===== 載入題庫 =====
async function loadBank(sub){
  const url = `questions/${sub}.json`;
  let res;
  try{
    res = await fetch(url, { cache: 'no-store' });
  }catch(err){
    throw new Error(`無法請求題庫（可能是用 file:// 開啟或 CORS）：${err.message}\n嘗試抓取：${location.origin}${location.pathname.replace(/[^/]+$/, '')}${url}`);
  }
  if(!res.ok){
    throw new Error(`題庫載入失敗：HTTP ${res.status} ${res.statusText}\n路徑：${url}\n（請確認 questions 資料夾與檔名大小寫）`);
  }
  const data = await res.json().catch(e=>{
    throw new Error(`JSON 解析失敗：${e.message}\n請檢查 ${url} 是否為有效 JSON 陣列。`);
  });
  if(!Array.isArray(data)) throw new Error('題庫格式錯誤：根節點必須是陣列 []');
  return data;
}

// ===== 渲染單一題（作答頁：不顯示章節/題號，也不顯示 explanation） =====
function renderOne(i){
  const q = paper[i];
  if(!q) return;

  const saved = answers[q.id];
  $('#quiz').innerHTML = `
    <div class="q" data-id="${q.id}">
      <div class="qid">第 ${i+1} 題／共 ${paper.length} 題　<span class="muted">${q.id || ''}</span></div>
      <div class="qt" style="font-size:20px">${q.question}</div>
      <div class="ops" style="margin-top:8px">
        ${q.options.map((op,k)=>`
          <label class="opt" data-idx="${k}">
            <input type="radio" name="${q.id}" value="${k}" ${saved===k?'checked':''} ${locked?'disabled':''}>
            ${op}
          </label>
        `).join('')}
      </div>
    </div>
  `;
  updatePager();
  updateNavButtons();
  updateSubmitState();
}

// ===== 題號總表 =====
function updatePager(){
  const p = $('#pager');
  p.innerHTML = paper.map((q,i)=>{
    const answered = typeof answers[q.id] === 'number';
    const cls = [
      'box',
      answered ? 'answered' : '',
      (i===idx) ? 'current' : '',
      locked ? 'locked' : ''
    ].join(' ');
    return `<div class="${cls}" data-i="${i}">${i+1}</div>`;
  }).join('');
}

// ===== 導航按鈕可用狀態 =====
function updateNavButtons(){
  $('#prevBtn').disabled = locked || idx<=0;
  $('#nextBtn').disabled = locked || idx>=paper.length-1;
}

// ===== 交卷防呆：尚有未作答題目時禁用交卷 =====
function updateSubmitState(){
  const btn = $('#submitBtn');
  if(!btn) return;
  const unanswered = paper.filter(q => typeof answers[q.id] !== 'number').length;
  btn.disabled = locked || unanswered > 0;
  btn.title = btn.disabled
    ? (locked ? '已交卷' : `還有 ${unanswered} 題未作答`)
    : '交卷';
}

// ===== 記錄作答 =====
function handleChange(e){
  const input = e.target;
  if(!input.matches('.q input[type="radio"]')) return;
  const qid = input.name;
  answers[qid] = Number(input.value);
  updatePager();
  updateSubmitState();
}

// ===== 計分 =====
function grade(){
  let correct=0;
  const wrongs=[];
  paper.forEach(q=>{
    const a = answers[q.id];
    if(a === q.answer) correct++;
    else wrongs.push({ q, your: (typeof a==='number') ? a : null });
  });
  const score = Math.round((correct/paper.length)*100);
  return { score, correct, total: paper.length, wrongs };
}

// ===== 初始化與事件 =====
async function boot(subject, fixedN){
  try{
    bank = await loadBank(subject);
  }catch(e){
    $('#quiz').innerHTML = `<div class="card">❌ <strong>Load failed</strong><br><pre style="white-space:pre-wrap">${e.message}</pre></div>`;
    return;
  }

  const n = Math.min(bank.length, fixedN);
  paper  = pickRandom(bank, n);
  idx = 0;
  answers = {};
  locked = false;

  renderOne(idx);

  // 改答案
  document.addEventListener('change', handleChange);

  // 上/下一題
  $('#prevBtn').addEventListener('click', ()=>{ if(idx>0 && !locked){ idx--; renderOne(idx); }});
  $('#nextBtn').addEventListener('click', ()=>{ if(idx<paper.length-1 && !locked){ idx++; renderOne(idx); }});

  // 題號方框跳轉
  $('#pager').addEventListener('click', (e)=>{
    const box = e.target.closest('.box');
    if(!box || locked) return;
    idx = Number(box.dataset.i);
    renderOne(idx);
  });

  // 重新抽題
  $('#reshuffleBtn').addEventListener('click', ()=>{
    if(locked) return;
    paper  = pickRandom(bank, n);
    idx = 0; answers = {};
    renderOne(idx);
    sessionStorage.removeItem('quizResult');
    updateSubmitState();
  });

  // 交卷：全部作答完才會啟用；計分→存到 sessionStorage→跳結果頁
  $('#submitBtn').addEventListener('click', ()=>{
    if($('#submitBtn').disabled) return;
    const r = grade();
    const payload = { subject, createdAt: new Date().toISOString(), ...r };
    sessionStorage.setItem('quizResult', JSON.stringify(payload));
    location.href = `results.html?subject=${encodeURIComponent(subject)}`;
  });

  // 開始測驗（重置本卷）
  $('#startBtn').addEventListener('click', ()=>{
    paper  = pickRandom(bank, n);
    idx = 0; answers = {}; locked = false;
    $$('button').forEach(b=> b.disabled=false);
    sessionStorage.removeItem('quizResult');
    renderOne(idx);
    updateSubmitState();
  });

  updateSubmitState();
}

/* ====== 結果頁渲染（只顯示錯題；顯示章節/題號；不顯示 explanation） ====== */
function renderResultsPage(){
  const main = document.querySelector('main.wrap') || document.body;
  const subject = getSubject() || 'basic';
  const raw = sessionStorage.getItem('quizResult');

  main.innerHTML = `
    <section class="hero" style="text-align:left">
      <div class="tagline">📊 測驗結果 · 科目：<span class="kbd">${subject}</span></div>
      <h1>本次成績</h1>
      <p class="muted" style="text-align:center">以下僅顯示錯題；正確選項以綠色標示、你的誤選以紅色標示。</p>
      <div class="cta-row" style="justify-content:flex-start">
        <a class="btn btn--primary" href="index.html?subject=${encodeURIComponent(subject)}">再測一次</a>
        <a class="btn btn--ghost" href="index.html">回首頁</a>
      </div>
    </section>
    <section id="result" class="result card"></section>
  `;

  const box = $('#result');
  if (!raw){
    box.innerHTML = `<div class="q">找不到上一份作答資料。請回到測驗頁重新作答。</div>`;
    return;
  }

  let data;
  try{ data = JSON.parse(raw); }
  catch{ box.innerHTML = `<div class="q">結果資料格式錯誤，請重新作答。</div>`; return; }

  const headerHtml = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div>
        <span class="badge ${data.score>=80 ? 'good':'bad'}">${data.score} 分</span>
        <span class="muted">正確 ${data.correct}/${data.total}</span>
      </div>
      <div class="muted">${new Date(data.createdAt).toLocaleString()}</div>
    </div>
  `;

  const listHtml = data.wrongs.length ? data.wrongs.map(w=>{
    const q = w.q;
    const your = w.your; // 可能為 null
    const optionsHtml = q.options.map((op, i) => {
      let cls = 'opt';
      if (i === q.answer) cls += ' is-correct';                       // 正解綠
      if (your != null && your !== q.answer && i === your) cls += ' is-wrong'; // 誤選紅
      return `<div class="${cls}"><strong>${String.fromCharCode(65+i)}.</strong> ${op}</div>`;
    }).join('');
    return `
      <div class="q">
        <div class="qt">${q.id || ''}｜${q.question}</div>
        ${fmtMeta(q) ? `<div class="muted" style="margin:4px 0 2px">${fmtMeta(q)}</div>` : ''}
        <div class="ops" style="margin-top:6px">${optionsHtml}</div>
      </div>
    `;
  }).join('') : '<div class="q">🎉 全對！本次沒有錯題。</div>';

  box.innerHTML = headerHtml + `<div style="margin-top:12px">${listHtml}</div>`;
}
