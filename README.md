# private-browser

집에서 쓰는 **원격 브라우저(Remote Browser Isolation)** — 취미·학습용.

모든 웹페이지는 서버의 Chromium에서 열리고, 내 기기(Chromebook 등)는 그 화면을
JPEG 프레임으로 받아 `<canvas>`에 그리기만 합니다. 클릭·키 입력만 서버로 보냅니다.
덕분에 방문한 사이트의 코드·쿠키·캐시가 내 기기에 들어오지 않고, 로컬 브라우저
기록도 앱 주소 하나로 유지됩니다.

> **용도와 범위**: 개인 기기에서, 집(개인) 네트워크로 쓰는 것을 전제로 합니다.
> 학교·회사가 **관리하는 기기나 네트워크의 필터·모니터링을 우회하는 용도가
> 아닙니다.** 그런 환경에서는 관리 시스템이 접속 사실·트래픽을 그대로 볼 수 있고,
> 네트워크 필터를 우회하는 효과는 이용 규정 위반이 될 수 있습니다.

## 구조

```
[내 기기]  Chrome 탭 1개 = 서버 주소 (PWA 가능)
   └─ <canvas> 로 화면 표시, 입력만 전송
        │  wss:// (TLS)  → 입력(JSON) / ← 화면(JPEG) + 상태(JSON)
[렌더 서버]  Caddy(자동 HTTPS) · Node + Playwright · Chromium(세션마다 새로, RAM 프로필)
        │  HTTPS
[실제 웹사이트]
```

- 화면 캡처: Chrome DevTools Protocol `Page.startScreencast` (JPEG)
- 입력 재현: CDP `Input.*` (`dispatchMouseEvent` / `dispatchKeyEvent` / `imeSetComposition` / `insertText`)
- 한글 입력: 조합 중 `imeSetComposition`, 확정 시 `insertText` (조합 중 keydown은 전송 안 함 → 중복 입력 방지)

## 폴더

```
apps/server/   렌더 서버 (Node ESM, 빌드 단계 없음)
  src/index.js        HTTP(정적+/login) + WebSocket(/ws) + 보안 헤더
  src/auth.js         비밀번호 로그인·1회용 티켓·레이트리밋·Origin 검사
  src/protocol.js     메시지 스키마 검증 + 바이너리 프레임 헤더
  src/browser.js      Chromium 실행(샌드박스 유지)
  src/session.js      세션 수명·유휴 종료·재연결 유예·파기
  src/tab.js          탭별 CDP 화면 캡처·상태·대화상자·다운로드
  src/input.js        입력 메시지 → CDP 변환
  src/urlPolicy.js    주소/검색어 판별 + 위험 스킴·사설 호스트 차단
apps/client/   브라우저 앱 (프레임워크·번들러 없이 ES 모듈)
  index.html, styles.css
  src/connection.js   로그인·WebSocket·자동 재연결
  src/viewer.js       canvas 렌더링·좌표 변환·리사이즈
  src/ui.js           주소창·탭바·대화상자·토스트
  src/privacy.js      제목 고정·히스토리 오염 방지
  src/input/          mouse.js · keyboard.js · ime.js
deploy/        Dockerfile · docker-compose.yml · Caddyfile · firewall.nft
.devcontainer/ Codespaces 설정
```

## 1. 개발·테스트 (GitHub Codespaces, 무료·리눅스 불필요)

**서버는 Codespace가 켜지면 자동으로 시작됩니다**(`.devcontainer/autostart.sh`).
편집기 탭이 멈추거나 닫혀도 서버는 컨테이너 안에서 계속 돌아갑니다.

1. 이 저장소에서 Codespace 생성 (브라우저 탭 안의 VS Code).
2. 1~2분 뒤 서버가 자동으로 떠요. 아래 **PORTS(포트)** 탭의 8080 주소
   (`https://...-8080.app.github.dev`)를 **집 기기**에서 열기.
   - 포트 가시성은 `private`(본인 GitHub 로그인 필요) 권장.
3. 로그인 비밀번호:
   - 기본값은 테스트용 **`test1234`** (자동 시작 편의를 위한 임시값).
   - 제대로 쓰려면 저장소 → Settings → Secrets → Codespaces에서
     `APP_PASSWORD`를 넣으세요. 그러면 그 값이 비밀번호가 됩니다.

수동으로 켜고 싶으면:
```bash
cd apps/server && npm install
APP_PASSWORD='강한-비밀번호' npm start
```

> Codespaces 컨테이너는 임시입니다. 변경한 코드는 꼭 커밋·푸시하세요.

## 2. 집에서 상시 사용 (Oracle Cloud Always Free 등)

```bash
# VM에서 (Docker + Compose 설치 후)
sudo nft -f deploy/firewall.nft            # egress SSRF 차단 (중요)
cd deploy
DOMAIN=my.duckdns.org APP_PASSWORD='강한-비밀번호' docker compose up -d
```

- DuckDNS(무료)로 서브도메인을 VM IP에 연결하면 Caddy가 HTTPS 인증서를 자동 발급·갱신합니다.
- 방화벽에서 80/443(과 SSH)만 열어두세요.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `APP_PASSWORD` | (필수) | 로그인 비밀번호. 없으면 서버가 시작을 거부함(오픈 프록시 방지) |
| `ALLOWED_ORIGINS` | (dev: 같은 호스트) | 허용할 Origin. 배포 시 `https://내도메인` 지정 |
| `PORT` / `HOST` | 8080 / 0.0.0.0 | 리슨 주소 |
| `HEADLESS` | true | Chromium 헤드리스 여부 |
| `IDLE_MS` | 900000 | 무입력 자동 종료(ms) |
| `GRACE_MS` | 60000 | 연결 끊김 후 세션 유지(ms) |
| `JPEG_QUALITY` | 70 | 화면 품질 |
| `SEARCH_URL` | DuckDuckGo | 검색 URL 접두사 |
| `START_URL` | DuckDuckGo | 시작 페이지 |
| `CHROMIUM_SANDBOX` | true | Chromium 샌드박스. 컨테이너에서 못 켜면 `false`(권장은 seccomp로 켜두기) |
| `PW_EXECUTABLE_PATH` | (자동) | Chromium 실행 파일 수동 지정(보통 불필요) |

### 브라우저가 시작되지 않을 때 (`브라우저 시작 실패`)

- **Codespaces/일반 컨테이너**: 샌드박스를 못 켜는 경우가 많습니다 → `CHROMIUM_SANDBOX=false`.
  (devcontainer 기본값에 이미 포함)
- **브라우저 바이너리 경로 오류**(`Executable doesn't exist`): 정상 `npm install` 또는
  Playwright Docker 이미지를 쓰면 안 납니다. 특수 환경이면 `PW_EXECUTABLE_PATH`로 지정.
- 샌드박스를 **켠 채로** 쓰려면(권장) Docker에서 Chrome seccomp 프로필을 쓰거나
  `cap_add: [SYS_ADMIN]`을 추가한 뒤 `CHROMIUM_SANDBOX=true`.

## 보안·프라이버시 설계 (요약)

- 로그인(비밀번호) + WebSocket 1회용 티켓, Origin 검사(CSWSH 방지), 동시 세션 1개
- 메시지 스키마 검증·크기/좌표 제한·레이트리밋, 클라이언트가 CDP를 직접 못 보냄
- 원격 문자열은 `textContent`만으로 표시(XSS 방지) + 엄격한 CSP
- SSRF: `urlPolicy.js`(문자열 차단) + `deploy/firewall.nft`(IP 차단, DNS 리바인딩 대비) **둘 다**
- Chromium 샌드박스 유지(`--no-sandbox` 금지), 비루트 실행, tmpfs(RAM) 프로필
- 서버는 URL·입력값을 로그로 남기지 않음, Caddy 접근 로그 기본 off
- 로컬: 앱 제목·아이콘 고정, 히스토리·폼 자동완성·맞춤법 검사 비활성

## 현재 구현 범위 (v0.1)

**됨**: 화면 스트리밍, 마우스·휠·우클릭, 영문·**한글 입력**, 붙여넣기, 주소창(검색/이동),
뒤로·새로고침, 멀티탭·팝업→탭, 로딩 표시, alert/confirm/prompt, 세션 파기·유휴 종료·자동 재연결.

**아직(다음 단계)**: 소리·부드러운 영상(WebCodecs/WebRTC), `<select>`·날짜 등 네이티브 팝업
대체 표시, 파일 다운로드 전송·업로드, 앞으로 가기 상태 정확도, 커서 모양 동기화, 터치스크린.

## 한계 (꼭 알아두기)

- 네트워크에는 "이 서버에 접속 중"이라는 사실이 보입니다(어느 사이트인지는 TLS로 가려짐).
- 원격 브라우저에서 로그인한 서비스(예: Google)의 계정 활동 기록은 그 서비스에 남습니다.
- 서버 호스팅 업체는 서버가 어디에 접속하는지 볼 수 있습니다(신뢰 대상을 옮기는 구조).
- 보안 프로그램 설치를 요구하는 일부 국내 사이트(은행 등)는 서버 리눅스 Chromium에서 안 될 수 있습니다.
