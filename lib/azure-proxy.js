// Azure OpenAI 중계 로직. server.js(로컬 Express)와 api/analyze.js(Vercel 서버리스)가
// 공유한다. 두 군데에 같은 코드를 두면 한쪽만 고쳐져 갈라지기 때문이다.
//
// 환경 변수
//   AZURE_ENDPOINT  (필수) chat/completions 전체 URL, api-version 쿼리 포함
//   AZURE_API_KEY   (필수) 리소스 키
//   ACCESS_CODE     (선택) 설정하면 이 값을 아는 사람만 호출할 수 있다

export const ACCESS_CODE_REQUIRED = 'ACCESS_CODE_REQUIRED';

// ACCESS_CODE 가 설정돼 있지 않으면 게이트 자체가 없다.
// 로컬 개발과 최초 배포가 설정 없이도 그대로 동작하도록 하기 위함이다.
export function checkAccess(providedCode) {
  const required = process.env.ACCESS_CODE;
  if (!required) return true;
  return providedCode === required;
}

// { status, body } 를 돌려준다. body 는 항상 문자열이며 호출자가 그대로 전달한다.
// Azure 의 상태코드를 그대로 넘겨야 브라우저 쪽 진단(401/404/429 …)이 계속 동작한다.
export async function callAzure(payload) {
  const endpoint = process.env.AZURE_ENDPOINT;
  const apiKey = process.env.AZURE_API_KEY;

  if (!endpoint || !apiKey) {
    console.error('[azure-proxy] AZURE_ENDPOINT / AZURE_API_KEY 가 설정되지 않았습니다.');
    return {
      status: 500,
      body: JSON.stringify({ error: 'AZURE_ENDPOINT / AZURE_API_KEY 환경 변수를 설정하세요.' }),
    };
  }

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      console.error('[azure-proxy] Azure 응답 ' + upstream.status + ': ' + text.slice(0, 500));
    }
    return { status: upstream.status, body: text };
  } catch (err) {
    console.error('[azure-proxy] Azure 호출 실패:', err);
    return { status: 502, body: JSON.stringify({ error: 'Azure 호출 실패: ' + err.message }) };
  }
}
