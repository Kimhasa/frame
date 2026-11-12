# FRAME 1단계 후속: Caddy 경유 HTTPS/WSS와 실기기 검증

작성 2026-11-09. `verification/REPORT.md` 마지막 절(공개 시청 웹 실제 중계 연동)의 후속입니다.

이 문서의 결과는 실제 Caddy가 TLS를 종단하는 HTTPS 주소에서 얻은 것입니다. 기존 Edge 루프백 e2e(`server/verify/web-e2e.mjs`)와 따로 기록합니다.
- 기존 e2e는 `http://127.0.0.1`에 있는 시험용 Node 프록시(`web-proxy.mjs`)를 썼습니다.
- 여기서는 폰이 여는 것과 같은 HTTPS 주소를 이 PC의 Edge와 Node로 열었습니다.
- 인터넷 회선이나 다른 PC는 거치지 않았습니다. 시청자 수용량 측정이 아닙니다.

## 시험 환경

| 항목 | 내용 |
| --- | --- |
| 구성 | 시험 송출(FFmpeg) → 중계 MediaMTX(`deploy/mediamtx-relay.yml`, 루프백 26xxx) → `server/relay.mjs`(원본 + 480p 래더) → Caddy v2.11.9(`deploy/test/Caddyfile.https-test`) |
| Caddy 역할 | 같은 HTTPS 호스트에서 `/_frame/`은 `apps/web/dist`(React 배포 빌드)를 제공하고, 나머지(API, HLS, DVR, 시청 세션, 채팅 WSS, 기존 `/<경로>` 시청 화면)는 중계로 넘김 |
| 주소 | `https://<기기>.<tailnet>.ts.net` (Tailscale MagicDNS 이름. 실제 주소는 시험 폴더의 `state.json`과 대화에서 전달) |
| 인증서 | Caddy 내부 CA(실행함). `tailscale cert`로 받는 Let's Encrypt 인증서(무료)로 하는 실행은 미실행 |
| 듣는 주소 | 이 PC의 Tailscale IPv4 443번만. LAN과 80번은 열지 않음. 시스템 인증서 저장소와 방화벽 설정은 바꾸지 않음 |
| `RELAY_PUBLIC_BASE_URL` | 시험 HTTPS 주소(목록의 `baseUrl`·`thumbnailUrl`이 이 주소로 나옴) |
| 운영과 다른 시험 설정 | `RELAY_LADDER_IDLE_MS=3600000`(폰이 늦게 들어와도 화질 래더가 식지 않게. 운영 기본은 5분), 송출 토큰이 `screen-02`도 허용(503 시험용 무영상 방송) |
| 시험 신호 | 1280×720 30 fps H.264 2.5 Mbps. 화면 위쪽에 PC 시계(HH:MM:SS)와 송출 경과 시간. 소리는 매초 0.15초 880 Hz 삐, 10초마다 1320 Hz 높은 삐(AAC + Opus) |
| 화질 | 원본 720p(`src`)와 480p(중계 래더) |
| 부하 | 시험 송출 전체가 CPU 약 5%(논리 CPU 16개 기준, 약 0.8코어), 메모리 약 500 MB. 같은 PC에서 메이플스토리 실행 중 |
| 도구 | Node 24.22.1, MediaMTX 1.21.3, FFmpeg 9.0.2, Edge 157(headless), Caddy v2.11.9(공식 릴리스, SHA-512 확인, `%LOCALAPPDATA%\FrameTest\caddy`) |

실행 명령
```
node server/verify/https-session.mjs --host <기기>.<tailnet>.ts.net --tls internal --bind <tailnet IPv4>   # 실행한 명령. Tailscale 인증서 실행(미실행)은 --tls tailscale
node server/verify/https-check.mjs
node server/verify/https-access-report.mjs --since <시작 시각>
node server/verify/https-session.mjs --stop
```
- 시험 폴더는 `%LOCALAPPDATA%\FrameTest\https`입니다(인증서 키, 녹화, 로그, `state.json`). 저장소 밖에 있습니다.
- 송출 토큰과 MediaMTX 비밀번호는 실행할 때마다 새로 만들고 메모리에만 둡니다. 로그에는 가려서 씁니다.

## Caddy (이 PC)

### 사전 실행: Caddy 내부 CA, 2026-11-09 17:44~17:46 (KST)
> 2026-11-10: 이 폴더의 `https-check-result.json`과 화면 파일은 같은 설정의 Node 대상 재실행으로 갱신됐습니다(18 통과, 실패 0, 미실행 2: 서비스 재시작 검사 H10이 추가됨). 아래 표의 수치는 2026-11-09 실행 값입니다. 배포하는 Spring 백엔드의 결과는 `verification/spring/RESULTS.md`에 있습니다.

`node server/verify/https-check.mjs` 결과는 17개 통과, 실패 0, 미실행 2입니다. 같은 날 17:33의 첫 실행(검토 반영 전)도 같은 항목이 모두 통과했습니다. 상세 값은 `verification/caddy/https-check-result.json`, 화면은 `https-*.png`에 있습니다.
- 주소는 실제 Tailscale 이름이었지만 인증서는 Caddy 내부 CA였습니다.
- 그래서 Edge는 그 인증서 하나만 신뢰하도록 고정했고(`--ignore-certificate-errors-spki-list`), Node는 루트를 추가 CA로 받았습니다.
- 브라우저 기본 신뢰(B1)는 이 실행으로는 확인할 수 없습니다. Tailscale 인증서 실행에서 확인합니다.

| 검사 | 결과 | 측정 |
| --- | --- | --- |
| A `caddy validate` | 통과 | `Valid configuration` |
| B1 인증서 기본 신뢰 | 미실행(내부 CA) | Windows `curl.exe`: `SEC_E_UNTRUSTED_ROOT`. 내부 CA라 예상된 결과. TLS 1.3, ALPN h2 |
| H1b Edge 보안 상태(인증서 플래그 없이) | 미실행(내부 CA) | 이 실행의 Edge는 인증서 고정 플래그로만 신뢰 |
| C 정적 파일 | 통과 | `/_frame` → 308 `/_frame/`. `/_frame/live`와 직접 시청 링크는 `index.html`(`no-cache`). 해시 자산은 `immutable`. 없는 자산은 404(`no-store`, HTML 아님). HSTS(시험값 `max-age=300`) 있음, `Server` 헤더 없음 |
| D 중계 전달 | 통과 | `/api/broadcasts`의 `baseUrl`·`thumbnailUrl`이 시험 HTTPS 주소. `/info`가 방송 ID와 `hls.scope`를 알림. 기존 `/screen-01` 화면 200, `/healthz` 200 |
| E 내부 주소 노출 | 통과 | API, `/info`, `live.m3u8`(원본·480p), 하위 재생 목록, `dvr`, `dvr.m3u8`에 루프백·LAN·tailnet 주소, 중계 포트, `http://`가 0건 |
| F 503 전달 | 통과 | 영상 없이 등록한 방송: `/info`는 `running:true, mediaReady:false`, `Retry-After: 2`. 방송 단위 `live.m3u8`과 `whep?b=`는 503 + `Retry-After: 2` + `no-store`이고, Caddy 경유 응답과 중계 직접 응답이 같음 |
| G WSS 업그레이드 | 통과 | HTTP/1.1로 `/screen-01/chat` 업그레이드 → `HTTP/1.1 101 Switching Protocols`, `Sec-WebSocket-Accept` 일치 |
| H1 목록 | 통과 | `/_frame/live`에 시험 방송 카드가 보이고, 누르면 `/_frame/watch/screen-01/<방송 ID>` |
| H2 재생 | 통과 | hls.js, 1280×720, 시험음 디코딩(4 s에 15 KB), RTCPeerConnection 0개, 첫 프레임 2.0 s, 지연 1.78 s |
| H3 직접 링크 새로고침 | 통과 | 문서 200(HTTP/2), 1.9 s 뒤 같은 방송 재생 |
| H4 화질 | 통과 | 메뉴: 자동 / 720p(원본) / 480p. 480p 전환 0.87 s, '자동'으로 720p 복귀 0.86 s(첫 실행: 0.12 s / 0.22 s) |
| H5 되감기·실시간 복귀 | 통과 | 타임라인 66 s 중 실시간 46 s 전으로: 2.1 s 만에 지난 구간 재생(시험음 계속), 목표와 차이 0.95 s, 녹화 요청 11건 모두 방송 단위 경로. 실시간 복귀 0.23 s, 지연 1.54 s |
| H6 채팅 | 통과 | 페이지 소켓 `wss://…/screen-01/chat` 101, 전송 응답 64 ms. 같은 방송에 붙은 Node 클라이언트가 122 ms 뒤 정확히 1번 수신 |
| H7 채팅 끊김·복구 | 통과 | `caddy reload --force`가 WSS를 끊음(118 ms) → 1.3 s 뒤 재접속(101). 서버 이력으로 다시 그림: 메시지 1번 표시, 중복 ID 0, 영상 재생 유지 |
| H8 네트워크 | 통과 | 요청 1,223건이 모두 시험 출처의 https(HTTP/2 1,209건). `http:` 0건, 혼합 콘텐츠 0건, 콘솔 오류 0건. 미디어 1,179건과 세션 요청(POST, 15초마다 PUT)이 모두 `/screen-01/b/<방송 ID>/` 아래 |
| H9 기존 시청 화면 | 통과 | `https://…/screen-01`이 열리고 영상이 진행(1280 폭). 요청 73건 모두 시험 출처 |

Caddy 접근 로그(같은 시간대)
- 채팅 업그레이드는 모두 `HTTP/1.1 GET 101`이었습니다. Edge도 HTTP/2 위의 WebSocket이 아니라 HTTP/1.1 업그레이드를 썼습니다.
- 503 응답은 모두 `Retry-After: 2`를 달고 나갔습니다.

### Tailscale 인증서 실행
미실행. 사용자가 tailnet의 HTTPS 인증서를 켜면 같은 명령을 `--tls tailscale`로 다시 실행합니다. B1(브라우저·Windows·Node 기본 신뢰)은 이 실행에서 확인합니다.

## iPhone Safari

미실행. 필요한 조건은 다음과 같습니다.
- tailnet HTTPS 인증서 켜기, iPhone에 Tailscale 앱 설치와 같은 계정 로그인.
- 시험 송출 실행.

## Android Chrome

미실행. 조건은 iPhone과 같습니다.

## 폰 확인 순서 (iPhone Safari, Android Chrome 각각)

폰에서 Tailscale을 켜 둡니다. Wi-Fi든 LTE든 상관없습니다. 각 단계의 시각(폰 시계)을 적어 두면 접근 로그와 맞춰 볼 수 있습니다.
0. **연결 확인**: `https://<시험 주소>/healthz`를 엽니다. JSON 한 줄이 보이면 폰이 tailnet으로 이 PC의 Caddy에 닿은 것입니다. 열리지 않으면 폰의 Tailscale 연결부터 봅니다.
1. **목록**: `https://<시험 주소>/_frame/live`를 엽니다.
   - 주소창에 인증서 경고가 없어야 합니다.
   - 'FRAME HTTPS 시험 방송'(HTTPS-TEST) 카드가 보여야 합니다.
2. **재생과 시험음**: 카드를 누릅니다.
   - 영상이 나오고, 화면 위쪽 PC 시계가 흘러야 합니다.
   - '소리 켜기'를 누르면 매초 삐 소리, 10초마다 높은 삐가 들려야 합니다.
   - 폰 시계와 화면 시계의 차이(대략 지연)를 적습니다.
3. **480p → 자동**: 화질 메뉴에서 480p를 고르면 글자가 조금 흐려지고 재생은 계속돼야 합니다. '자동'을 고르면 다시 선명해져야 합니다.
4. **되감기 → 실시간 복귀**: 타임라인을 30~60초 전으로 옮깁니다.
   - 화면 시계가 그만큼 과거여야 하고, 시험음도 계속 들려야 합니다.
   - '실시간 복귀'를 누르면 현재 시각으로 돌아와야 합니다.
5. **채팅**: 닉네임을 정하고 메시지를 보냅니다.
   - 다른 폰(또는 PC)에서도 1번만 보여야 합니다.
   - 비행기 모드를 5초 켰다 끄거나 Wi-Fi와 LTE를 바꾼 뒤, 메시지가 중복 없이 다시 보이고 새 메시지를 보낼 수 있어야 합니다.
6. **직접 링크 새로고침**: 시청 화면에서 새로고침하거나 시청 주소를 새 탭으로 엽니다. 같은 방송이 다시 재생돼야 합니다.
7. (가능하면) 화면 회전, 홈 화면에 다녀오기, 잠금 후 복귀 뒤에도 재생과 채팅이 이어지는지 봅니다.

실패하면 다음을 보내 주세요.
- 발생 시각(폰 시계), 직전 조작, 실제 증상(화면 문구 그대로).
- 스크린샷이나 화면 녹화.
- 기기와 OS 버전(예: iPhone 15, iOS 18.x / Galaxy S23, Android 15).

재생 경로와 실제 화질은 Caddy 접근 로그로 기록합니다(`node server/verify/https-access-report.mjs --since <시각>`).
- 기기별로 다음을 정리합니다.
  - iOS 플레이어(`AppleCoreMedia`)가 미디어를 요청했는지(iOS 기본 HLS), 브라우저가 요청했는지(hls.js, MSE·ManagedMediaSource).
  - 요청한 화질 경로(`src`, `480p`)와 전환 시각.
  - DVR·세션·채팅 요청의 상태 코드, 사용한 HTTP 버전.
- 폰에는 개발자 도구가 없어서 `window.FrameRuntime`은 읽지 않습니다. iPhone은 Mac Safari 웹 속성, Android는 PC Chrome의 `chrome://inspect`가 있으면 추가로 볼 수 있습니다.

## 시험 설정의 독립 검토

시험 설정 세 파일을 읽기 전용 에이전트 4개(Caddy 의미, 보안·노출, 프로세스 수명, 검사 판정)가 검토했습니다. 지적마다 다른 에이전트가 반증을 시도했습니다. 지적 17건 중 확인된 12건은 모두 고쳤고, 반박 4건과 불확실 1건은 따로 판단했습니다.
- **검사 판정**
  - 내부 CA용 인증서 고정 해시가 EC 키에서 틀림(사전 실행에서 먼저 발견해 고침).
  - 시험 주소가 IP이거나 포트가 26xxx일 때 내부 주소 노출 검사(E)가 시험 주소 자체를 잡음.
  - 확인할 수 없는 항목을 '실패'로 셈 → '미실행'으로 따로 셈.
  - CDP 호출에 시간 제한이 없어, 멈추거나 Ctrl+C 하면 Edge가 남음 → 모든 호출에 시간 제한, 15분 감시, 신호 처리.
- **보안·노출**
  - 제어 포트가 이 PC의 다른 웹 페이지의 POST를 받음 → `Host`가 정확히 루프백이고 `Origin`이 없을 때만 받음(브라우저형 요청 403 확인).
  - 결과 파일에 잘린 호스트 이름이 남을 수 있음 → 자르기 전에 익명화.
  - 시험 HSTS 1년 → 5분.
- **프로세스 수명**
  - 시작 실패 사유가 실행 로그에 남지 않음 → 실행 로그와 `state.json`에 기록.
  - `--stop`이 실제 종료 전에 성공을 알림 → 상태 파일과 PID로 종료를 확인한 뒤 알림.
  - 송출 등록이 15초 넘게 끊기면 썸네일이 사라짐 → 60초마다 다시 올림, 시계 공백 기록.
  - Caddy가 시험 설정을 `%AppData%Caddy`에 자동 저장함 → `persist_config off`와 Caddy 데이터·설정 폴더를 시험 폴더로 지정. 이미 생긴 파일은 지우지 않고 시험 폴더로 옮김.
- **Caddy**
  - HTTP/3 문구가 고정 텍스트였음 → 시험에서 HTTP/3를 끄고 문구를 바꿈.
  - 50 MiB 로그 교체 시 앞선 폰 요청이 요약에서 빠짐 → 시험 중에는 교체하지 않게 1 GiB.
- **반박·불확실**
  - 방화벽이 폰을 막는다는 지적은 반박됐습니다(`Tailscale-In` 허용 규칙. 아래 미실행 표).
  - SPKI 해시 지적 2건은 검토 시점에 이미 고쳐져 있었습니다.
  - PC 검사가 방화벽을 거치지 않는다는 사실을 결과에 적으라는 지적은, 결함이 아니라는 이유로 반박됐습니다. 그래도 결과 파일의 미확인 항목에 넣었습니다.
  - HSTS 지적은 '불확실'(설정 실패는 아님)이었지만 `ts.net`이 미리 등록되지 않았다는 확인이 있어 시험값을 줄였습니다.

## 운영 설정 변경이 필요한 항목

운영 설정(`deploy/Caddyfile.example`)은 바꾸지 않았습니다. 시험 환경에서 확인한 결과와 필요한 변경은 다음과 같습니다.

1. **React 공개 웹 제공(`/_frame/`)**
   - 지금 운영 예시는 모든 요청을 중계로 넘깁니다. React 웹을 배포할 때는 시험 설정의 `redir /_frame` 블록과 `handle_path /_frame/*` 블록을 운영 사이트 블록에 옮기고, `root`를 서버의 빌드 경로로 바꿉니다.
   - 시험에서 확인한 동작: 화면 주소만 `index.html`(`no-cache`), 해시 자산은 1년 `immutable`, 없는 자산은 404(`no-store`). API·HLS·DVR·세션·채팅·기존 `/<경로>` 화면은 그대로 중계로 갑니다(C, D, H1~H9).
2. **설정 다시 읽기와 채팅 연결**
   - Caddy는 설정을 다시 읽을 때 중계 중인 WebSocket을 끊습니다. 시험(H7)에서 `caddy reload --force` 뒤 채팅 소켓이 0.1초 만에 끊겼고, 페이지는 0.9초 뒤 중복 없이 다시 붙었습니다.
   - 운영에서 다시 읽기를 할 때마다 모든 시청자의 채팅이 한꺼번에 다시 붙습니다. 동시 재접속을 줄이려면 `reverse_proxy`에 `stream_close_delay`(예: 5분)를 두는 방안을 검토합니다(미적용, 미측정).
3. **HSTS**: 운영 예시의 1년 값은 그대로 둡니다. 시험 설정만 5분으로 줄였습니다(시험 호스트의 HSTS가 폰에 1년 남지 않게).
4. **자동 저장**: 운영에서도 `caddy run`은 설정을 사용자 설정 폴더에 자동 저장합니다(`persist_config`). systemd 운영에서는 큰 문제가 아니라 그대로 둡니다. 시험 설정에서만 `persist_config off`로 껐습니다.
5. **HTTP/3**: 운영 예시는 Caddy 기본값(h1 h2 h3)을 그대로 둡니다.
   - 시험 설정은 `protocols h1 h2`로 껐습니다. tailnet MTU(1280)에는 QUIC 첫 패킷이 들어가지 않아 폰이 QUIC을 시도하다 TCP로 내려가고, PC는 루프백 경로라 HTTP/3가 되어 PC 결과가 폰을 대표하지 못하기 때문입니다.
   - 그래서 인터넷에서 폰이 HTTP/3로 보는 경우는 이번에 확인하지 않습니다. 운영 서버 방화벽에서 UDP 443이 막혀 있으면 브라우저가 TCP로 내려가므로 기능 문제는 없습니다.

## 미실행과 필요한 조건

| 항목 | 상태 | 필요한 조건 |
| --- | --- | --- |
| 공개 신뢰 인증서로 PC 브라우저·Windows·Node 신뢰 확인(B1) | 미실행 | tailnet DNS 설정에서 HTTPS Certificates 켜기(사용자). 켜면 `tailscale cert`로 Let's Encrypt 인증서를 받고, 같은 검사를 다시 실행 |
| iPhone Safari | 미실행 | 위 인증서 + iPhone Tailscale 앱 로그인 + 시험 송출 실행 |
| Android Chrome | 미실행 | 위 인증서 + Android Tailscale 앱 로그인 + 시험 송출 실행 |
| 다른 기기에서 이 PC의 443번 접속 | 미확인 | 이 PC의 검사는 자기 Tailscale 주소로 가는 내부 경로라 방화벽과 Tailscale 어댑터를 거치지 않음. 방화벽은 읽기만 해서 확인: Tailscale이 설치한 `Tailscale-In`(사용, 인바운드 허용, 도메인·개인, 이 PC의 Tailscale 주소, 모든 프로토콜·포트)이 있고 Tailscale 인터페이스는 '개인' 프로필이라 막히지 않을 것으로 봄. Tailscale ACL이 막을 수는 있음. 폰의 `/healthz`로 처음 확인 |
| HTTP/3(QUIC) | 시험에서 끔 | 시험 Caddy는 `protocols h1 h2`(위 운영 항목 5). 다시 읽은 뒤 `Alt-Svc` 없음, UDP 443 수신 없음을 확인 |
| 인터넷 회선·CDN·도메인 인증서(운영 형태) | 범위 밖 | 운영 서버, 공개 도메인, CDN이 필요(이번은 tailnet 안 시험) |
| 1,000명 시청 | 범위 밖 | 이번 검사는 페이지 1~2개의 기능 확인 |
