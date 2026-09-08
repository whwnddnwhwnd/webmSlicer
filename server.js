// 로컬 개발 서버. 정적 파일 서빙 + /api/analyze 중계만 한다.
//
// 의존성이 없다(Node 내장 http 만 사용). express 를 쓰지 않는 이유:
// package.json 에 express 가 있으면 Vercel 이 이 프로젝트를 "Express 서버 앱"으로
// 판단해 서버 엔트리포인트를 찾다가 빌드가 실패한다. 우리가 Vercel 에서 원하는 것은
// 정적 파일 + 서버리스 함수(api/analyze.js)이지 상시 실행 서버가 아니다.
// express 가 여기서 하던 일은 정적 서빙과 POST 라우트 하나뿐이라 내장 모듈로 충분하다.
//
// file:// 로 직접 열지 않고 굳이 서버를 두는 이유:
// file:// 오리진에서는 비디오를 그린 캔버스가 오염(taint)되어 이미지 추출이 막힐 수 있다.
// http://localhost 로 서빙하면 blob: URL 이 동일 오리진이라 안전하다.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAzure, checkAccess, ACCESS_CODE_REQUIRED } from './lib/azure-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const MAX_BODY = 25 * 1024 * 1024; // 원본 해상도 프레임의 base64 는 보통 300KB 안쪽

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

function sendJson(res, status, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('요청 본문이 너무 큽니다'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Vercel 의 api/analyze.js 와 같은 경로·같은 로직(lib/azure-proxy.js)을 쓴다.
// 브라우저는 같은 오리진인 이 경로로 보내므로 CORS 가 발생하지 않고,
// API 키는 서버 환경 변수에만 남아 페이지 소스에 노출되지 않는다.
async function handleAnalyze(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST 만 허용합니다.' });
  if (!checkAccess(req.headers['x-access-code'])) {
    return sendJson(res, 401, { error: ACCESS_CODE_REQUIRED });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, 400, { error: '요청 본문을 읽지 못했습니다: ' + err.message });
  }

  const { status, body } = await callAzure(payload);
  sendJson(res, status, body);
}

async function handleStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);

  // path.resolve 가 .. 를 정규화하므로, 결과가 public/ 밖이면 탈출 시도다.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  try {
    const data = await readFile(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/analyze') await handleAnalyze(req, res);
    else await handleStatic(req, res, pathname);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 오류: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  프레임 슬라이서\n  → http://localhost:${PORT}\n`);
  if (!process.env.AZURE_ENDPOINT || !process.env.AZURE_API_KEY) {
    console.log('  (AI 분석을 쓰려면 AZURE_ENDPOINT / AZURE_API_KEY 를 설정하세요.');
    console.log('   .env.example 을 .env 로 복사한 뒤 node --env-file=.env server.js)\n');
  }
});
