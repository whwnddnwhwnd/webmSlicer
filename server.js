// 기본적으로는 정적 파일 서빙만 담당한다.
// 영상 디코딩·프레임 캡처는 전부 브라우저에서 일어나므로 서버는 영상을 보지 않는다.
//
// file:// 로 직접 열지 않고 굳이 서버를 두는 이유:
// file:// 오리진에서는 비디오를 그린 캔버스가 오염(taint)되어 toBlob() 이 막힐 수 있다.
// http://localhost 로 서빙하면 blob: URL 이 동일 오리진이라 안전하다.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAzure, checkAccess, ACCESS_CODE_REQUIRED } from './lib/azure-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

// Vercel 의 api/analyze.js 와 같은 경로·같은 로직(lib/azure-proxy.js)이다.
// 브라우저는 같은 오리진인 이 경로로 보내므로 CORS 가 발생하지 않고,
// API 키는 서버 환경 변수에만 남아 페이지 소스에 노출되지 않는다.
app.post('/api/analyze', express.json({ limit: '25mb' }), async (req, res) => {
  if (!checkAccess(req.headers['x-access-code'])) {
    return res.status(401).json({ error: ACCESS_CODE_REQUIRED });
  }

  const { status, body } = await callAzure(req.body);
  res.status(status).type('application/json').send(body);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  프레임 슬라이서\n  → http://localhost:${PORT}\n`);
  if (!process.env.AZURE_ENDPOINT || !process.env.AZURE_API_KEY) {
    console.log('  (AI 분석을 쓰려면 AZURE_ENDPOINT / AZURE_API_KEY 를 설정하세요.');
    console.log('   .env.example 을 .env 로 복사한 뒤 node --env-file=.env server.js)\n');
  }
});
