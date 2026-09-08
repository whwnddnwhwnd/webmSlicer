// 기본적으로는 정적 파일 서빙만 담당한다.
// 영상 디코딩·프레임 캡처는 전부 브라우저에서 일어나므로 서버는 영상을 보지 않는다.
//
// file:// 로 직접 열지 않고 굳이 서버를 두는 이유:
// file:// 오리진에서는 비디오를 그린 캔버스가 오염(taint)되어 toBlob() 이 막힐 수 있다.
// http://localhost 로 서빙하면 blob: URL 이 동일 오리진이라 안전하다.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════════════════
//  Azure OpenAI 프록시 설정
//
//  public/app.js 의 USE_PROXY 가 true 일 때만 쓰인다.
//  브라우저 직접 호출이 CORS 에 막힐 경우의 우회로다.
//  (Azure OpenAI 는 기본적으로 브라우저 직접 호출을 허용하지 않는다.)
// ══════════════════════════════════════════════════════════════════════════

const AZURE_ENDPOINT = process.env.AZURE_ENDPOINT || '';
const AZURE_API_KEY = process.env.AZURE_API_KEY || '';

// ══════════════════════════════════════════════════════════════════════════

const app = express();

// 브라우저는 같은 오리진인 이 경로로 보내므로 CORS 가 발생하지 않고,
// API 키는 서버에만 남아 페이지 소스에 노출되지 않는다.
// 본문은 app.js 가 만든 Azure 요청 그대로라, 여기서는 헤더만 붙여 중계한다.
app.post('/api/analyze', express.json({ limit: '25mb' }), async (req, res) => {
  if (!AZURE_ENDPOINT || !AZURE_API_KEY) {
    console.error('[proxy] server.js 의 AZURE_ENDPOINT / AZURE_API_KEY 가 비어 있습니다.');
    return res.status(500).json({
      error: 'server.js 상단의 AZURE_ENDPOINT / AZURE_API_KEY 가 비어 있습니다.',
    });
  }

  try {
    const upstream = await fetch(AZURE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': AZURE_API_KEY },
      body: JSON.stringify(req.body),
    });

    // 상태코드를 그대로 넘겨야 브라우저 쪽 진단(401/404/429 …)이 계속 동작한다.
    const text = await upstream.text();
    if (!upstream.ok) console.error('[proxy] Azure 응답 ' + upstream.status + ': ' + text.slice(0, 500));
    res.status(upstream.status).type('application/json').send(text);
  } catch (err) {
    console.error('[proxy] Azure 호출 실패:', err);
    res.status(502).json({ error: 'Azure 호출 실패: ' + err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  프레임 슬라이서\n  → http://localhost:${PORT}\n`);
});
