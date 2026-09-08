// Vercel 서버리스 함수 — Azure OpenAI 프록시.
//
// Vercel 은 상시 실행 서버가 없어 server.js 의 app.listen() 이 호출되지 않는다.
// 대신 api/ 아래 파일이 자동으로 엔드포인트가 되므로, server.js 의 /api/analyze 와
// 똑같은 일을 하는 함수를 여기 둔다. 경로가 같아서 클라이언트 코드는 로컬과 동일하다.
//
// 실제 중계 로직은 lib/azure-proxy.js 를 server.js 와 공유한다.
// 키는 환경 변수에서만 읽으며 public/ 아래로는 절대 내려가지 않는다.

import { callAzure, checkAccess, ACCESS_CODE_REQUIRED } from '../lib/azure-proxy.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 만 허용합니다.' });
  }

  if (!checkAccess(req.headers['x-access-code'])) {
    return res.status(401).json({ error: ACCESS_CODE_REQUIRED });
  }

  const { status, body } = await callAzure(req.body);
  res.status(status).setHeader('Content-Type', 'application/json');
  return res.send(body);
}
