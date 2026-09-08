// Vercel 서버리스 함수 — Azure OpenAI 프록시.
//
// Vercel 은 상시 실행 서버가 없어 server.js 의 app.listen() 이 호출되지 않는다.
// 대신 api/ 아래 파일이 자동으로 엔드포인트가 되므로, server.js 의 /api/analyze 와
// 똑같은 일을 하는 함수를 여기 둔다. 경로가 같아서 클라이언트 코드는 로컬과 동일하다.
//
// 키는 Vercel 프로젝트의 환경 변수에서만 읽는다. 절대 public/ 아래로 내려가지 않는다.
//   AZURE_ENDPOINT, AZURE_API_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 만 허용합니다.' });
  }

  const endpoint = process.env.AZURE_ENDPOINT;
  const apiKey = process.env.AZURE_API_KEY;

  if (!endpoint || !apiKey) {
    console.error('[analyze] 환경 변수 AZURE_ENDPOINT / AZURE_API_KEY 가 설정되지 않았습니다.');
    return res.status(500).json({
      error: 'Vercel 프로젝트에 AZURE_ENDPOINT / AZURE_API_KEY 환경 변수를 설정하세요.',
    });
  }

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify(req.body),
    });

    // 상태코드를 그대로 넘겨야 브라우저 쪽 진단(401/404/429 …)이 계속 동작한다.
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error('[analyze] Azure 응답 ' + upstream.status + ': ' + text.slice(0, 500));
    }
    res.status(upstream.status).setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (err) {
    console.error('[analyze] Azure 호출 실패:', err);
    return res.status(502).json({ error: 'Azure 호출 실패: ' + err.message });
  }
}
