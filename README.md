# 프레임 슬라이서

동영상을 균등 간격으로 잘라 프레임 그리드로 보여주는 한 페이지 웹 도구.

```bash
npm install
npm start          # http://localhost:3000
```

## 무엇을 하나

1. 영상 파일을 고른다 (최대 500MB, 브라우저가 재생 가능한 형식 전부 — webm/mp4/mov …)
2. 최상단에서 원본을 재생한다
3. **10 / 25 / 50 / 100장** 중 하나를 고르면 영상 전체를 그만큼 균등 분할해 프레임을 뽑아 그리드로 보여준다
4. 프레임을 클릭하면 상단 영상이 그 시점으로 점프하고, 원본 해상도 확대 모달이 열린다 (저장 가능)
5. 모달의 **[AI 분석]** 버튼으로 그 프레임을 Azure OpenAI 에 보내 분석하고, 결과를 `alert` 로 띄운다

## Azure OpenAI 설정

기본값은 `USE_PROXY = true` 다. 브라우저는 같은 오리진의 `/api/analyze` 로 보내고,
키는 서버 환경 변수에만 존재한다.

```bash
cp .env.example .env          # AZURE_ENDPOINT / AZURE_API_KEY 를 채운다
node --env-file=.env server.js
```

`public/app.js` 의 `PROMPT` 로 질문을 바꾼다.
설정이 비어 있으면 호출하지 않고 안내만 띄운다.

로컬에서 서버를 거치지 않고 시험해 보려면 `USE_PROXY` 를 `false` 로 바꾸고
`public/app.js` 의 `AZURE_ENDPOINT` / `AZURE_API_KEY` 를 채운다.
**단 이 상태로는 절대 배포하면 안 된다** — 아래 참조.

## Vercel 배포

Vercel 은 상시 실행 서버가 없어 `server.js` 의 `app.listen()` 이 호출되지 않는다.
대신 `api/analyze.js` 가 서버리스 함수로 잡힌다. 경로가 `/api/analyze` 로 같아서
클라이언트 코드는 로컬과 배포에서 동일하다.

```
로컬   브라우저 → /api/analyze → server.js       ┐
                                                ├→ lib/azure-proxy.js → Azure
Vercel 브라우저 → /api/analyze → api/analyze.js  ┘
```

중계 로직은 `lib/azure-proxy.js` 하나에 두고 양쪽이 공유한다. 두 벌로 두면 한쪽만
고쳐져 갈라지기 때문이다.

1. Vercel 에서 이 저장소를 import (Framework Preset: **Other**)
2. **Environment Variables** 를 등록한다
   - `AZURE_ENDPOINT` (필수)
   - `AZURE_API_KEY` (필수)
   - `ACCESS_CODE` (선택 — 공개 URL 이라면 권장. 아래 참조)
3. Deploy

`vercel.json` 이 `framework: null`(프레임워크 감지 끔)과 `outputDirectory: public` 을
명시하므로 대시보드에서 따로 만질 것은 없다. 배포 후 루트가 404 라면 프로젝트 설정의
**Output Directory** 가 `public` 인지 확인한다.

> 저장소가 비공개면 Vercel 의 Import 목록에 뜨지 않는다. Import 화면의
> **Configure GitHub App** 에서 해당 저장소 접근을 허용해야 한다.

### 배포 시 반드시 지킬 것

**`USE_PROXY` 는 반드시 `true` 여야 한다.** `public/app.js` 는 정적 파일이라 브라우저에
통째로 내려간다. `false` 로 두고 거기에 키를 적으면, 배포 URL 을 여는 누구나 개발자도구로
키를 그대로 가져갈 수 있다. `.gitignore` 로도 막을 수 없다 — 앱 본체 파일이기 때문이다.

**공개 URL 이라면 `ACCESS_CODE` 를 설정한다.** 설정하지 않으면 `/api/analyze` 는 무인증이라
URL 을 아는 사람 누구나 호출할 수 있고, 그만큼 Azure 쿼터가 소모된다.

`ACCESS_CODE` 환경 변수를 넣으면 그 값을 헤더로 보낸 요청만 통과한다. 앱은 401 을 받으면
코드를 한 번 물어보고 재시도하며, 맞으면 그 탭의 `sessionStorage` 에 담아 다시 묻지 않는다.
**코드는 소스에 두지 않는다** — `public/` 은 정적 파일이라 소스에 박힌 값은 방문자에게
그대로 내려가 게이트 역할을 못 하기 때문이다.

변수를 비워 두면 게이트 자체가 없다. 로컬 개발과 최초 배포가 설정 없이도 동작한다.

### 함수 실행 시간

GPT-4o 비전 호출은 응답까지 5~15초가 걸린다. Vercel 함수 기본 타임아웃(10초)으로는
부족할 수 있어 `vercel.json` 에서 `maxDuration` 을 60초로 올려 두었다.

### CORS 에 막히면

**Azure OpenAI 는 기본적으로 브라우저 직접 호출을 허용하지 않는다.** `api-key` 는 CORS
안전목록 헤더가 아니라 프리플라이트가 먼저 나가는데, Azure 가 여기에 응답하지 않으면 실제
POST 는 네트워크에 나가지도 못한다. 로컬 실행이어도 동일하다 — CORS 는 배포 여부가 아니라
오리진이 다른지만 본다.

이 실패는 **상태코드가 아예 없이** `TypeError: Failed to fetch` 로만 오기 때문에 401 인지
404 인지 구분이 안 된다. 그래서 상태코드가 없으면 CORS 로 단정하고 콘솔에 해결책을 찍는다.

막혔다면 `public/app.js` 의 `USE_PROXY` 를 `true` 로 바꾸고, `server.js` 상단의
`AZURE_ENDPOINT` / `AZURE_API_KEY` 를 채운다. 그러면 브라우저는 동일 오리진인
`/api/analyze` 로 보내고 Node 가 중계하므로 CORS 가 사라지고, API 키도 페이지 소스에
노출되지 않는다. 업스트림 상태코드는 그대로 전달되어 아래 진단이 계속 동작한다.

### 실패 진단

alert 은 `분석 실패 (404)` 정도로 짧게 뜨고, 원인과 원본 응답은 콘솔(F12)에 남는다.

| 상태코드 | 콘솔에 안내되는 원인 |
|---|---|
| (없음) | CORS 차단 — `USE_PROXY` 를 켤 것 |
| 401 / 403 | API 키 오류 |
| 404 | 경로 오류 — **배포 이름(deployment name) 오타가 가장 흔함** |
| 400 | 비전 미지원 모델이거나 콘텐츠 필터 |
| 429 | 쿼터 초과 |
| 500 | 프록시 사용 중이면 `server.js` 상수 확인 |

응답을 기다리는 사이 모달을 닫으면 결과는 콘솔에만 남기고 alert 은 띄우지 않는다.
이미 떠난 화면에 대한 알림은 성공이든 실패든 소음이기 때문이다.

## 아키텍처

**영상은 서버로 올라가지 않는다.** 디코딩과 프레임 캡처가 전부 브라우저에서 일어난다.
`URL.createObjectURL(file)` 은 파일을 메모리로 읽는 게 아니라 디스크상의 파일을 가리키는
참조라, 500MB 든 그 이상이든 메모리 점유가 비슷하다.

서버(`server.js`)는 정적 파일 서빙과 `/api/analyze` 중계만 한다. ffmpeg 설치가 필요 없고
영상 처리에 서버 CPU·디스크를 쓰지 않는다.

**의존성이 없다.** Node 내장 `http` 만 쓴다. `express` 를 넣으면 Vercel 이 이 프로젝트를
"Express 서버 앱"으로 판단해 서버 엔트리포인트를 찾다가 빌드가 실패한다
(`No entrypoint found which imports express`). 우리가 Vercel 에서 원하는 것은
정적 파일 + 서버리스 함수이지 상시 실행 서버가 아니다.

> `file://` 로 직접 열지 않고 굳이 Express 를 두는 이유: `file://` 오리진에서는 비디오를 그린
> 캔버스가 오염(taint)되어 이미지 추출이 막힐 수 있다. `http://localhost` 로 서빙하면
> blob URL 이 동일 오리진이라 안전하다.

```
파일 선택 → blob URL
              ├─ playerVideo   최상단, 사용자가 보는 것
              └─ captureVideo  화면 밖, seek 전용 ── 서로 간섭하지 않는다
                     ↓
              duration 확정 → 슬롯 k 의 목표 시각 = k × duration / 100
                     ↓
              seek → drawImage → JPEG 인코딩 (썸네일 320px + 원본 해상도)
```

## 설계상 알아둘 것

**슬롯은 항상 100칸으로 고정한다.** 모든 프리셋(10/25/50/100)이 100의 약수라 프리셋을
올려도 이미 캡처한 슬롯을 그대로 재사용한다 — 10장을 뽑아둔 뒤 100장을 누르면 90장만 추가로
뽑는다. 내릴 때는 캡처가 전혀 일어나지 않는다(측정값 0ms).

**캡처용 `<video>` 를 분리한다.** 같은 엘리먼트를 seek 하면 사용자가 보던 재생 위치가 튄다.

**`canvas.toBlob()` 을 쓰지 않는다.** Chrome 의 `toBlob` 은 인코딩을 idle task 로 예약하는데,
idle 구간이 잡히지 않는 환경에서는 내부 타임아웃 1000ms 를 통째로 기다린 뒤에야 실행된다.
실측으로 7KB JPEG 한 장에 1,044ms 가 걸려 프레임당 비용을 33ms 에서 2,100ms 로 63배 부풀렸다.
`OffscreenCanvas.convertToBlob()` 도 같은 경로라 1,035ms 로 동일하게 느리다.
동기 경로인 `toDataURL()` 은 같은 프레임이 32ms 였으므로, 동기로 인코딩한 뒤 직접 Blob 으로
바꾼다. 결과물은 완전히 같은 blob URL 이다.

**`duration = Infinity` 대응.** `MediaRecorder`(브라우저 화면녹화·웹캠)로 만든 webm 은 헤더에
Duration 이 없어 "100등분" 계산 자체가 불가능하다. 아주 큰 값으로 seek 해 브라우저가 실제 길이를
확정하게 만든 뒤 0으로 되돌린다. 그래도 실패하면 프레임 추출을 포기하고 안내하되 재생은 남긴다.

**fps 표시는 참고용이다.** 총 장수 기준이라 간격 계산(`duration / 100`)에는 fps 가 필요 없다.
`requestVideoFrameCallback` 으로 근사치를 재고, 못 재면 숨기지 않고 "fps 측정 불가"로 표시한다.

## 이번 범위에 없는 것

프레임 일괄 다운로드(ZIP) · 노트/주석 · 결과 공유 URL · 여러 영상 보관 · 새로고침 후 복구 ·
가상 스크롤(100장 상한에서는 불필요) · 여러 프레임 일괄 AI 분석 · 분석 결과 보관
