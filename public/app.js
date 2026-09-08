// 프레임 슬라이서 — 브라우저에서 영상을 균등 간격으로 잘라 그리드로 보여준다.
//
// 핵심 설계
//  - 서버로 아무것도 올리지 않는다. URL.createObjectURL(file) 은 파일을 메모리로 읽는 게 아니라
//    디스크상의 파일을 가리키는 참조라, 500MB 든 그 이상이든 메모리 점유가 비슷하다.
//  - 슬롯은 항상 100칸으로 고정한다. 모든 프리셋(10/25/50/100)이 100의 약수라
//    프리셋을 올려도 이미 캡처한 슬롯은 그대로 재사용된다(증분 캡처, 낭비 0).
//  - 캡처용 video 를 따로 둔다. 사용자가 보는 플레이어와 분리되어 있어야
//    seek 을 100번 때려도 재생 위치가 튀지 않는다.

// ══════════════════════════════════════════════════════════════════════════
//  Azure OpenAI 설정 — 여기만 채우면 된다
// ══════════════════════════════════════════════════════════════════════════

// 호출 경로. true 면 같은 오리진의 /api/analyze 를 거친다
// (로컬은 server.js, Vercel 은 api/analyze.js — 경로가 같아 코드 변경이 없다).
//
// ⚠ 배포한다면 반드시 true 여야 한다.
//    이 파일은 정적 파일이라 브라우저에 통째로 내려간다. false 로 두고 아래 상수에
//    키를 채우면, 배포 URL 을 여는 누구나 개발자도구로 키를 그대로 가져갈 수 있다.
//    true 일 때 키는 서버 환경 변수에만 있고 이 파일에는 존재하지 않는다.
const USE_PROXY = true;

// 아래 두 상수는 USE_PROXY 가 false 일 때만 쓰인다 (= 로컬 전용).
// 전체 URL 을 그대로 붙여넣는다 (api-version 쿼리까지 포함).
//   https://<리소스>.openai.azure.com/openai/deployments/<배포이름>/chat/completions?api-version=2024-10-21
const AZURE_ENDPOINT = '';

const AZURE_API_KEY = '';

// GPT 에 보낼 질문. 결과를 alert 로 띄우므로 길이를 제한해 두는 편이 좋다.
const PROMPT = '이 이미지에 무엇이 보이는지 한국어로 3문장 이내로 설명해줘.';

const MAX_TOKENS = 300;

// ══════════════════════════════════════════════════════════════════════════

const SLOT_COUNT = 100;
const PRESETS = [10, 25, 50, 100];
const MAX_BYTES = 500 * 1024 * 1024;
const THUMB_WIDTH = 320;
const SEEK_TIMEOUT_MS = 15000;

const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $('fileInput'),
  fileMeta: $('fileMeta'),
  notice: $('notice'),
  empty: $('empty'),
  playerSection: $('playerSection'),
  player: $('player'),
  controls: $('controls'),
  presetGroup: $('presetGroup'),
  intervalText: $('intervalText'),
  barFill: $('barFill'),
  progressText: $('progressText'),
  cancelBtn: $('cancelBtn'),
  gridSection: $('gridSection'),
  grid: $('grid'),
  capture: $('capture'),
  fullCanvas: $('fullCanvas'),
  thumbCanvas: $('thumbCanvas'),
  modal: $('modal'),
  modalBackdrop: $('modalBackdrop'),
  modalSlot: $('modalSlot'),
  modalTime: $('modalTime'),
  modalImg: $('modalImg'),
  analyzeBtn: $('analyzeBtn'),
  saveBtn: $('saveBtn'),
  closeBtn: $('closeBtn'),
};

const state = {
  file: null,
  blobUrl: null,
  duration: 0,
  width: 0,
  height: 0,
  fps: undefined, // undefined = 아직 안 잼, null = 재봤지만 실패, number = 근사치
  slots: new Array(SLOT_COUNT).fill(null), // { time, thumbUrl, fullUrl }
  preset: 10,
  capturing: false,
  cancelled: false,
  captureToken: 0,
  seekTimes: [],
  modalIndex: null,
  currentIndex: null,
  analyzing: false,
};

// ---------------------------------------------------------------- 유틸

// canvas.toBlob() 을 쓰지 않는 이유:
// Chrome 의 toBlob 은 인코딩을 idle task 로 예약하고, idle 구간이 잡히지 않는 환경에서는
// 내부 타임아웃 1000ms 를 통째로 기다린 뒤에야 실행된다. 실측으로 7KB JPEG 한 장에 1,044ms 가
// 걸렸고, 이는 프레임당 비용을 33ms(seek) 에서 2,100ms 로 63배 부풀렸다.
// OffscreenCanvas.convertToBlob() 도 같은 경로라 1,035ms 로 동일하게 느리다.
// toDataURL() 은 동기 경로라 그 스케줄러를 타지 않는다 — 같은 프레임이 32ms.
// 그래서 동기로 인코딩한 뒤 직접 Blob 으로 바꾼다. 결과물은 완전히 같은 blob URL 이다.
function canvasToObjectURL(canvas, quality) {
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + s
               : String(m).padStart(2, '0') + ':' + s;
}

function fileTimeTag(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = (sec % 60).toFixed(2).padStart(5, '0').replace('.', '-');
  return h + 'h' + m + 'm' + s + 's';
}

const formatBytes = (b) =>
  b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + 'GB' : (b / 1024 ** 2).toFixed(1) + 'MB';

// 프리셋이 사용하는 슬롯 번호. 100의 약수라 항상 정수 stride 로 떨어진다.
function presetIndices(n) {
  const stride = SLOT_COUNT / n;
  return Array.from({ length: n }, (_, k) => k * stride);
}

const slotTargetTime = (i) => (i * state.duration) / SLOT_COUNT;

function showNotice(msg, isError) {
  els.notice.textContent = msg;
  els.notice.classList.toggle('error', Boolean(isError));
  els.notice.hidden = false;
}

const clearNotice = () => { els.notice.hidden = true; };

// ---------------------------------------------------------------- 비디오 준비

// readyState >= HAVE_CURRENT_DATA 가 되어야 drawImage 로 프레임을 뽑을 수 있다.
function waitReady(video) {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('영상을 읽을 수 없습니다')); };
    function cleanup() {
      video.removeEventListener('loadeddata', ok);
      video.removeEventListener('error', fail);
    }
    video.addEventListener('loadeddata', ok, { once: true });
    video.addEventListener('error', fail, { once: true });
  });
}

// MediaRecorder 로 만든 webm 은 헤더에 Duration 이 없어 duration 이 Infinity 로 나온다.
// 아주 큰 값으로 seek 하면 브라우저가 끝까지 훑으면서 실제 길이를 확정한다.
async function resolveDuration(video) {
  // 메타데이터가 오기 전에는 duration 이 NaN 이다. 여기서 바로 판단하면
  // 멀쩡한 파일도 '깨진 파일' 경로로 새서 1e101 seek 을 헛되이 때린다.
  if (video.readyState < 1) {
    await new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('영상을 읽을 수 없습니다')); };
      function cleanup() {
        video.removeEventListener('loadedmetadata', ok);
        video.removeEventListener('error', fail);
      }
      video.addEventListener('loadedmetadata', ok, { once: true });
      video.addEventListener('error', fail, { once: true });
    });
  }

  if (isFinite(video.duration) && video.duration > 0) return video.duration;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('영상 길이를 확인하지 못했습니다'));
    }, 30000);

    function onDurationChange() {
      if (!isFinite(video.duration) || video.duration <= 0) return;
      cleanup();
      video.currentTime = 0;
      resolve(video.duration);
    }
    function onError() { cleanup(); reject(new Error('영상을 읽을 수 없습니다')); }
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('error', onError);
    }

    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('error', onError, { once: true });
    video.currentTime = 1e101;
  });
}

// fps 는 총 장수 계산에 필요하지 않다(간격 = duration / 100). 화면에 띄우는 참고 정보일 뿐이라
// 짧게 재생하며 프레임 간격을 재서 근사치를 구한다. Firefox 에는 rVFC 가 없어 null 을 돌려준다.
function measureFps(video) {
  if (typeof video.requestVideoFrameCallback !== 'function') return Promise.resolve(null);

  return new Promise((resolve) => {
    const times = [];
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.pause();
      video.currentTime = 0;
      if (times.length < 5) return resolve(null);
      const deltas = [];
      for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > 0) deltas.push(d);
      }
      if (!deltas.length) return resolve(null);
      deltas.sort((a, b) => a - b);
      const median = deltas[Math.floor(deltas.length / 2)];
      resolve(median > 0 ? Math.round(1 / median) : null);
    }

    const timer = setTimeout(finish, 2500);

    function onFrame(_now, meta) {
      times.push(meta.mediaTime);
      if (times.length >= 40) return finish();
      video.requestVideoFrameCallback(onFrame);
    }

    video.muted = true;
    video.currentTime = 0;
    video.play().then(
      () => video.requestVideoFrameCallback(onFrame),
      () => finish()
    );
  });
}

// ---------------------------------------------------------------- 캡처

function seekTo(video, t) {
  return new Promise((resolve, reject) => {
    // 이미 그 위치에 있으면 seeked 이벤트가 안 뜬다 (슬롯 0 = 0초에서 걸린다).
    if (Math.abs(video.currentTime - t) < 0.001 && video.readyState >= 2) {
      state.seekTimes.push(0);
      resolve();
      return;
    }

    const started = performance.now();

    function onSeeked() {
      const ms = performance.now() - started;
      state.seekTimes.push(ms);
      if (ms > 1500) console.warn('[seek] ' + t.toFixed(2) + 's -> ' + ms.toFixed(0) + 'ms (느림)');
      cleanup();
      resolve();
    }
    function onError() { cleanup(); reject(new Error('seek 실패')); }
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('seek 시간 초과 (' + t.toFixed(2) + 's)'));
    }, SEEK_TIMEOUT_MS);

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = t;
  });
}

async function captureSlot(i) {
  const video = els.capture;
  const target = slotTargetTime(i);
  await seekTo(video, target);

  // seek 후 currentTime 은 브라우저가 요청받은 값을 그대로 돌려준다(프레임 PTS 로 스냅되지 않는다).
  // 화면에 뜨는 프레임은 그 시각을 포함하는 프레임이다.
  const actual = video.currentTime;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) throw new Error('영상 크기를 읽을 수 없습니다');

  // 원본 해상도 — 확대 모달과 저장용
  els.fullCanvas.width = vw;
  els.fullCanvas.height = vh;
  els.fullCanvas.getContext('2d').drawImage(video, 0, 0, vw, vh);
  const fullUrl = canvasToObjectURL(els.fullCanvas, 0.85);

  // 썸네일 — 그리드용. 원본 해상도 100장을 그리드에 그대로 얹으면
  // 디코딩된 픽셀만 수백 MB 가 되므로 반드시 줄여서 따로 만든다.
  const tw = Math.min(THUMB_WIDTH, vw);
  const th = Math.max(1, Math.round((vh * tw) / vw));
  els.thumbCanvas.width = tw;
  els.thumbCanvas.height = th;
  els.thumbCanvas.getContext('2d').drawImage(video, 0, 0, tw, th);
  const thumbUrl = canvasToObjectURL(els.thumbCanvas, 0.8);

  state.slots[i] = { time: actual, thumbUrl, fullUrl };
}

// 매 반복마다 현재 프리셋을 다시 읽는다. 그래서 캡처 도중 프리셋을 바꾸면
// 진행 중인 한 장만 마저 끝내고 곧바로 새 목표로 넘어간다.
async function runCapture() {
  if (state.capturing) return;
  state.capturing = true;
  state.cancelled = false;
  const token = ++state.captureToken;
  renderProgress();

  try {
    for (;;) {
      if (state.cancelled || token !== state.captureToken) break;
      const next = presetIndices(state.preset).find((i) => !state.slots[i]);
      if (next === undefined) break;
      await captureSlot(next);
      renderGrid();
      renderProgress();
    }
  } catch (err) {
    console.error(err);
    showNotice('프레임 캡처를 중단했습니다: ' + err.message, true);
  } finally {
    state.capturing = false;
    renderProgress();
    logSeekStats();
  }
}

function logSeekStats() {
  const t = state.seekTimes.filter((v) => v > 0);
  if (!t.length) return;
  const avg = t.reduce((a, b) => a + b, 0) / t.length;
  const max = Math.max.apply(null, t);
  console.log('[seek 통계] ' + t.length + '회 · 평균 ' + avg.toFixed(0) + 'ms · 최대 ' + max.toFixed(0) + 'ms');
}

// ---------------------------------------------------------------- 렌더링

function renderMeta() {
  if (!state.file) { els.fileMeta.textContent = ''; return; }
  const parts = [
    '<b>' + state.file.name + '</b>',
    formatBytes(state.file.size),
    state.duration ? formatTime(state.duration) : '길이 확인 중…',
  ];
  if (state.width) parts.push(state.width + '×' + state.height);
  // fps 는 총 장수 계산에 쓰이지 않는 참고 정보다. 못 쟀으면 숨기지 말고 못 쟀다고 밝힌다.
  if (state.fps === null) parts.push('fps 측정 불가');
  else if (state.fps) parts.push('약 ' + state.fps + 'fps');
  els.fileMeta.innerHTML = parts.join(' · ');
}

function renderPresets() {
  els.presetGroup.innerHTML = '';
  for (const n of PRESETS) {
    const btn = document.createElement('button');
    btn.textContent = n + '장';
    btn.className = n === state.preset ? 'active' : '';
    btn.addEventListener('click', () => setPreset(n));
    els.presetGroup.appendChild(btn);
  }
  els.intervalText.textContent = state.duration
    ? '약 ' + (state.duration / state.preset).toFixed(2) + '초 간격'
    : '';
}

function renderProgress() {
  const indices = presetIndices(state.preset);
  const done = indices.filter((i) => state.slots[i]).length;
  const total = indices.length;
  els.barFill.style.width = ((done / total) * 100) + '%';

  if (state.capturing) {
    els.progressText.textContent = done + ' / ' + total + ' 캡처 중…';
    els.cancelBtn.hidden = false;
  } else {
    els.cancelBtn.hidden = true;
    els.progressText.textContent =
      done === total ? total + '장 준비 완료' : done + ' / ' + total + ' — 중단됨';
  }
}

function renderGrid() {
  const indices = presetIndices(state.preset);
  els.grid.innerHTML = '';

  indices.forEach((i, order) => {
    const slot = state.slots[i];
    const card = document.createElement('div');
    card.className = 'card' + (slot ? '' : ' pending') + (i === state.currentIndex ? ' current' : '');
    card.dataset.index = String(i);

    if (slot) {
      const img = document.createElement('img');
      img.className = 'shot';
      img.src = slot.thumbUrl;
      img.loading = 'lazy';
      img.alt = formatTime(slot.time) + ' 프레임';
      card.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'placeholder';
      ph.textContent = '대기';
      card.appendChild(ph);
    }

    const cap = document.createElement('div');
    cap.className = 'cap';
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = '#' + (order + 1);
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = formatTime(slot ? slot.time : slotTargetTime(i));
    cap.append(idx, ts);
    card.appendChild(cap);

    if (slot) card.addEventListener('click', () => onFrameClick(i));
    els.grid.appendChild(card);
  });
}

// ---------------------------------------------------------------- 상호작용

function setPreset(n) {
  if (n === state.preset) return;
  state.preset = n;
  state.cancelled = false;
  renderPresets();
  renderGrid();
  renderProgress();
  runCapture(); // 이미 돌고 있으면 다음 반복에서 새 목표를 집어간다
}

function onFrameClick(i) {
  const slot = state.slots[i];
  if (!slot) return;

  // 1) 상단 영상을 그 시점으로 점프. duration 이 확정되지 않은 파일에서는 무시될 수 있다.
  if (isFinite(els.player.duration) && els.player.duration > 0) {
    els.player.currentTime = Math.min(slot.time, els.player.duration - 0.01);
  }
  // 2) 확대 모달은 영상 탐색에 의존하지 않으므로 어떤 파일에서도 항상 뜬다.
  openModal(i);
}

function openModal(i) {
  const slot = state.slots[i];
  if (!slot) return;
  state.modalIndex = i;
  const order = presetIndices(state.preset).indexOf(i) + 1;
  els.modalSlot.textContent = '#' + order + ' / ' + state.preset;
  els.modalTime.textContent = formatTime(slot.time);
  els.modalImg.src = slot.fullUrl;
  setAnalyzing(state.analyzing); // 진행 중인 요청이 있으면 버튼 상태를 유지
  els.modal.hidden = false;
}

function closeModal() {
  els.modal.hidden = true;
  els.modalImg.removeAttribute('src');
  state.modalIndex = null;
}

function saveCurrentFrame() {
  const slot = state.slots[state.modalIndex];
  if (!slot) return;
  const base = (state.file ? state.file.name : 'frame').replace(/\.[^.]+$/, '');
  const a = document.createElement('a');
  a.href = slot.fullUrl;
  a.download = base + '_' + String(state.modalIndex).padStart(3, '0') + '_' + fileTimeTag(slot.time) + '.jpg';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------- AI 분석

function setAnalyzing(on) {
  state.analyzing = on;
  els.analyzeBtn.disabled = on;
  els.analyzeBtn.textContent = on ? '분석 중…' : 'AI 분석';
}

// 서버에 ACCESS_CODE 가 설정돼 있으면 401 + ACCESS_CODE_REQUIRED 로 답한다.
// 코드를 이 파일에 두지 않는 것이 핵심이다 — public/ 은 정적 파일이라 방문자에게
// 그대로 내려가므로, 소스에 박힌 코드는 게이트 역할을 전혀 못 한다.
// 사용자가 입력한 값을 그 탭의 sessionStorage 에만 담는다.
function getAccessCode() {
  try { return sessionStorage.getItem('accessCode') || ''; } catch { return ''; }
}
function setAccessCode(value) {
  try {
    if (value) sessionStorage.setItem('accessCode', value);
    else sessionStorage.removeItem('accessCode');
  } catch { /* 시크릿 모드 등에서 접근이 막힐 수 있다 */ }
}

function postAnalyze(payload) {
  if (!USE_PROXY) {
    return fetch(AZURE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': AZURE_API_KEY },
      body: JSON.stringify(payload),
    });
  }
  const headers = { 'Content-Type': 'application/json' };
  const code = getAccessCode();
  if (code) headers['x-access-code'] = code;
  return fetch('/api/analyze', { method: 'POST', headers, body: JSON.stringify(payload) });
}

// 캡처해 둔 blob URL 을 다시 읽어 data URL 로 바꾼다.
// Azure OpenAI 는 이미지를 base64 data URL 로 받으므로 바이너리 그대로는 못 보낸다.
async function blobUrlToDataUrl(blobUrl) {
  const blob = await (await fetch(blobUrl)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다'));
    reader.readAsDataURL(blob);
  });
}

// 상태코드만 보고는 뭘 고쳐야 할지 알 수 없는 경우가 많아 원인별 해설을 붙인다.
function diagnose(status) {
  if (status === null) {
    return [
      '요청이 네트워크 레벨에서 실패했습니다 (상태코드가 아예 없음).',
      'Azure OpenAI 는 기본적으로 브라우저 직접 호출을 허용하지 않으므로 거의 항상 CORS 차단입니다.',
      '',
      '해결: public/app.js 의 USE_PROXY 를 true 로 바꾸고,',
      '      server.js 상단의 AZURE_ENDPOINT / AZURE_API_KEY 를 채우세요.',
    ].join('\n');
  }
  switch (status) {
    case 401:
    case 403:
      return 'API 키가 올바르지 않거나 권한이 없습니다. AZURE_API_KEY 를 확인하세요.';
    case 404:
      return [
        '엔드포인트 경로를 찾을 수 없습니다.',
        'Azure OpenAI 의 404 는 리소스명보다 배포 이름(deployment name) 오타인 경우가 훨씬 많습니다.',
        'URL 형태: https://<리소스>.openai.azure.com/openai/deployments/<배포이름>/chat/completions?api-version=2024-10-21',
      ].join('\n');
    case 400:
      return '요청이 거부되었습니다. 배포한 모델이 이미지 입력을 지원하는지(gpt-4o 계열) 확인하세요. 콘텐츠 필터일 수도 있습니다.';
    case 429:
      return '요청 한도(쿼터)를 초과했습니다. 잠시 후 다시 시도하세요.';
    case 500:
      return USE_PROXY
        ? '프록시(server.js)에서 오류가 났습니다. 서버 콘솔과 server.js 상단의 AZURE_ENDPOINT / AZURE_API_KEY 를 확인하세요.'
        : 'Azure 쪽 서버 오류입니다. 아래 원본 응답을 확인하세요.';
    default:
      return '알 수 없는 오류입니다. 아래 원본 응답을 확인하세요.';
  }
}

// stale = 응답이 오는 사이 모달이 닫혔거나 다른 프레임으로 옮겨간 경우.
// 알림은 사용자가 아직 기다리고 있는 작업에만 띄운다. 이미 떠난 화면에 대해
// 뒤늦게 튀어나오는 alert 는 성공이든 실패든 소음이므로 콘솔에만 남긴다.
function reportFailure(status, detail, stale) {
  console.error(
    '[AI 분석 실패] ' + (status === null ? '(상태코드 없음)' : 'HTTP ' + status) + '\n\n' +
    diagnose(status) + '\n\n원본:', detail);
  if (stale) {
    console.warn('[AI 분석] 모달이 닫혀 있어 alert 는 생략했습니다.');
    return;
  }
  alert('분석 실패' + (status === null ? '' : ' (' + status + ')') +
        '\n자세한 원인은 콘솔(F12)을 확인하세요.');
}

async function analyzeCurrentFrame() {
  const index = state.modalIndex;
  const slot = state.slots[index];
  if (!slot || state.analyzing) return;

  // 설정 누락은 오류가 아니라 설치 단계다. 첫 실행 전에 콘솔을 열어볼 이유가 없으므로
  // 이 경우만 예외적으로 alert 에 전문을 띄운다.
  if (!USE_PROXY && (!AZURE_ENDPOINT || !AZURE_API_KEY)) {
    alert('Azure 설정이 비어 있습니다.\n\n' +
          'public/app.js 맨 위의\n' +
          '  AZURE_ENDPOINT\n  AZURE_API_KEY\n' +
          '두 상수를 채운 뒤 새로고침하세요.');
    return;
  }

  setAnalyzing(true);
  try {
    const dataUrl = await blobUrlToDataUrl(slot.fullUrl);

    // Azure OpenAI chat/completions 형식. 프록시를 쓸 때도 본문은 동일하고
    // server.js 가 api-key 헤더만 붙여 그대로 전달한다.
    const payload = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: MAX_TOKENS,
    };

    let res = await postAnalyze(payload);
    let raw = await res.text();

    // 접근 코드를 요구하면 한 번만 물어보고 재시도한다.
    const needsCode = (r, body) => r.status === 401 && body.includes('ACCESS_CODE_REQUIRED');
    if (needsCode(res, raw)) {
      const entered = prompt('이 서버는 접근 코드가 필요합니다.');
      if (!entered) {
        console.warn('[AI 분석] 접근 코드 입력이 취소되었습니다.');
        return;
      }
      setAccessCode(entered);
      res = await postAnalyze(payload);
      raw = await res.text();
      if (needsCode(res, raw)) {
        setAccessCode('');  // 틀린 코드를 남겨두면 다음 시도에서 다시 물어보지 못한다
        alert('접근 코드가 올바르지 않습니다.');
        return;
      }
    }

    let json = null;
    try { json = JSON.parse(raw); } catch { /* 본문이 JSON 이 아닐 수 있다 */ }

    // 응답이 오는 사이에 모달을 닫았거나 다른 프레임으로 옮겼는가.
    const stale = state.modalIndex !== index;

    if (!res.ok) {
      reportFailure(res.status, json || raw, stale);
      return;
    }

    if (stale) {
      console.warn('[AI 분석] 모달이 닫혀 결과를 버립니다.', json);
      return;
    }

    const choice = json && json.choices && json.choices[0];
    const text = choice && choice.message && choice.message.content;
    if (!text) {
      const reason = choice && choice.finish_reason;
      console.error('[AI 분석] 응답에 내용이 없습니다. finish_reason =', reason, '\n원본:', json || raw);
      alert('분석 결과가 비어 있습니다' + (reason ? ' (' + reason + ')' : '') +
            '.\n자세한 내용은 콘솔(F12)을 확인하세요.');
      return;
    }

    alert(text);
  } catch (err) {
    // fetch 가 던지는 TypeError = 네트워크 레벨 실패. 상태코드가 없다.
    reportFailure(null, err, state.modalIndex !== index);
  } finally {
    setAnalyzing(false);
  }
}

// 재생 중 현재 시각에 해당하는 카드를 강조한다. duration 이 없어도 currentTime 은 흐르므로
// 탐색이 안 되는 파일에서도 이 연동은 동작한다.
function syncCurrentFrame() {
  if (!state.duration) return;
  const indices = presetIndices(state.preset);
  const t = els.player.currentTime;
  let best = null;
  for (const i of indices) {
    if (slotTargetTime(i) <= t + 1e-6) best = i;
    else break;
  }
  if (best === state.currentIndex) return;
  state.currentIndex = best;
  for (const card of els.grid.children) {
    card.classList.toggle('current', Number(card.dataset.index) === best);
  }
}

// ---------------------------------------------------------------- 파일 로드

function releaseAll() {
  for (const slot of state.slots) {
    if (!slot) continue;
    URL.revokeObjectURL(slot.thumbUrl);
    URL.revokeObjectURL(slot.fullUrl);
  }
  state.slots = new Array(SLOT_COUNT).fill(null);
  if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
  state.blobUrl = null;
  state.seekTimes = [];
  state.currentIndex = null;
}

async function loadFile(file) {
  // 크기 검사는 기존 상태를 건드리기 전에 한다.
  // 뒤에서 하면 거부당한 파일 하나 때문에 작업 중이던 영상과 프레임이 통째로 날아간다.
  if (file.size > MAX_BYTES) {
    showNotice(
      '파일이 ' + formatBytes(file.size) + ' 입니다. 최대 500MB 까지만 처리합니다.' +
      (state.file ? ' 기존 영상은 그대로 두었습니다.' : ''), true);
    return;
  }

  state.captureToken++; // 진행 중이던 캡처 루프를 무효화
  state.cancelled = true;
  closeModal();
  clearNotice();
  releaseAll();

  state.file = file;
  state.duration = 0;
  state.width = 0;
  state.height = 0;
  state.fps = undefined;
  state.preset = PRESETS[0];

  const url = URL.createObjectURL(file);
  state.blobUrl = url;
  els.player.src = url;
  els.capture.src = url;

  els.empty.hidden = true;
  els.playerSection.hidden = false;
  els.controls.hidden = false;
  els.gridSection.hidden = false;
  renderMeta();
  renderPresets();
  renderGrid();
  els.progressText.textContent = '영상 분석 중…';

  try {
    await waitReady(els.capture);

    // 플레이어 쪽 duration 도 같이 확정해 둬야 진행바와 프레임 클릭 점프가 동작한다.
    // 플레이어는 실패해도 캡처에는 지장이 없으므로 삼킨다.
    const [duration] = await Promise.all([
      resolveDuration(els.capture),
      resolveDuration(els.player).catch(() => null),
    ]);

    state.duration = duration;
    state.width = els.capture.videoWidth;
    state.height = els.capture.videoHeight;
    renderMeta();
    renderPresets();
    renderGrid();

    state.fps = await measureFps(els.capture);
    renderMeta();

    await runCapture();
  } catch (err) {
    console.error(err);
    showNotice(err.message + '. 이 파일은 프레임 추출을 할 수 없습니다 (재생은 가능할 수 있습니다).', true);
    els.progressText.textContent = '';
  }
}

// ---------------------------------------------------------------- 바인딩

els.fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) loadFile(file);
  e.target.value = ''; // 같은 파일을 다시 골라도 change 가 뜨도록
});

els.cancelBtn.addEventListener('click', () => { state.cancelled = true; });
els.analyzeBtn.addEventListener('click', analyzeCurrentFrame);
els.saveBtn.addEventListener('click', saveCurrentFrame);
els.closeBtn.addEventListener('click', closeModal);
els.modalBackdrop.addEventListener('click', closeModal);
els.player.addEventListener('timeupdate', syncCurrentFrame);
els.player.addEventListener('seeked', syncCurrentFrame);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.modal.hidden) closeModal();
});

renderPresets();
