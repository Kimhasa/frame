# FRAME API (Spring Boot)

FRAME 백엔드입니다. 인터넷 중계 서버에 배포하는 중계 웹 서비스이며(`deploy/`의 systemd 단위가 이 jar를 실행), 제품 API(로그인·채널 프로필·팔로우·방송 예약·시청 기록·알림·신고 관리·채팅 정책과 계정 차단·방송 투표·질문과 답변·비현금 포인트와 보상·무료 미션과 진행 이력)도 같은 프로세스에 둡니다.
제품 API는 PostgreSQL·Redis를 사용하는 opt-in 기능으로 구현되어 있습니다. 요청 계약, 설정, 보안 경계와 검증은 [PRODUCT_API.md](PRODUCT_API.md)를 따릅니다. 기본 비활성 상태에서는 기존 중계 실행에 DB·Redis가 필요하지 않습니다.
- **OBS 입력(2026-11-11)**: C++ 앱은 보존하고 OBS를 기본 송출 도구로 연결할 수 있습니다. opt-in 자동 등록, 경로별 인증, PC 시험 방법은 [deploy/OBS.md](../../deploy/OBS.md)에 있습니다. OBS는 별도 announce 프로그램 없이 미디어만 보냅니다.
- 송출 앱(`native/`)과 React 웹(`apps/web/`)은 이 앱과 HTTP·WebSocket·RTSP(S) 계약으로만 연결합니다. 이 앱은 다른 앱의 소스 폴더를 읽지 않습니다.
- 이전 Node 중계(`server/relay.mjs`)의 기능(등록·목록, 재생, 화질 래더, DVR, 채팅, WHEP, 재생 통계, 기존 시청 화면)을 모두 옮겼습니다. Node 구현은 배포하지 않고 검증의 비교 기준으로만 남아 있습니다. 아래 "이식 상태"를 봅니다.

## 실행

JDK 21이 필요합니다. 이 PC에서는 `%LOCALAPPDATA%\FrameTools\jdk-21.0.13+9`를 씁니다(`JAVA_HOME`은 명령마다 지정).

```bash
cd apps/api
export JAVA_HOME="$LOCALAPPDATA/FrameTools/jdk-21.0.13+9"   # PowerShell: $env:JAVA_HOME = "$env:LOCALAPPDATA\FrameTools\jdk-21.0.13+9"
./gradlew test          # 단위 테스트
./gradlew bootJar       # build/libs/frame-api.jar
./gradlew bootRun       # 개발 실행 (환경 변수는 아래)
java -jar build/libs/frame-api.jar
```

- Gradle 8.14.5 Wrapper, Spring Boot 4.1.2, Spring MVC(Tomcat) + 가상 스레드.
- LL-HLS 블로킹 재요청처럼 오래 열린 요청은 가상 스레드 하나씩으로 처리합니다.

## 설정

모든 값은 Node 중계와 같은 `RELAY_*` 환경 변수로 줍니다. 그래서 `deploy/relay.env.example`(서버에서는 `/etc/frame-relay/relay.env`)과 검증 스크립트의 환경을 그대로 쓸 수 있습니다. 기본값과 의미는 `src/main/resources/application.yml`에 있습니다.
- Node처럼 빈 값(`RELAY_X=`)은 설정하지 않은 것으로 봅니다(`BlankRelayVariables`).
- 범위를 벗어난 값은 시작을 멈춥니다.
- 시작할 때 토큰 수, 켜진 기능(화질, DVR, HLS, 통계, 기존 화면), `*` 토큰 경고, 어떤 설정도 읽지 않는 `RELAY_*` 변수(오타)를 로그에 남깁니다(`StartupNotes`).

| 변수 | 쓰임 |
| --- | --- |
| `RELAY_LISTEN_HOST`, `RELAY_PORT` | 듣는 주소(기본 `127.0.0.1:8080`). 인터넷 쪽은 Caddy가 받습니다. |
| `RELAY_PUBLIC_BASE_URL`, `RELAY_TRUSTED_PROXIES` | 목록의 `baseUrl`·`thumbnailUrl`. 비우면 신뢰한 프록시의 `X-Forwarded-*` 또는 `Host`. |
| `RELAY_PUBLISHER_TOKENS`, `RELAY_PUBLISHER_TOKENS_FILE` | 송출 토큰 `"<토큰> <경로> [<경로> ...]"`. SHA-256으로만 보관합니다. 저장소에 넣지 않습니다. |
| `RELAY_MEDIAMTX_API`, `_HLS`, `_WEBRTC`, `_PLAYBACK`, `_RTSP`, `_API_USER/PASS`, `_STALE_MS` | 중계 MediaMTX(루프백 http만). API와 녹화 재생 서버는 이 서비스로 노출하지 않습니다. |
| `RELAY_ANNOUNCE_TTL_MS`, `RELAY_MEDIA_GRACE_MS`, `RELAY_SESSION_ACTIVE_MS` | 등록 수명 15 s, 영상이 잠깐 끊긴 동안 기다리는 시간 15 s, 시청 세션 활성 30 s. |
| `RELAY_HLS_COUNT_WITHOUT_SESSION`, `RELAY_HLS_ACTIVE_MS` | 세션 없이 HLS를 받는 클라이언트도 주소+브라우저로 시청자에 셈(기본 켬, 12 s). CDN 뒤에서는 끕니다. |
| `RELAY_MAX_BROADCASTS`, `RELAY_MAX_VIEWERS_PER_PATH`, `RELAY_MAX_SESSIONS_PER_IP`, `RELAY_MAX_SOCKETS` | 상한. 넘으면 503 + `Retry-After`. `RELAY_MAX_SOCKETS`는 Tomcat의 열린 연결 수(유휴 keep-alive와 채팅 포함)로 셉니다. |
| `RELAY_MAX_CHAT`, `RELAY_MAX_CHAT_PER_IP`, `RELAY_MAX_WHEP_INFLIGHT`, `RELAY_MAX_DVR_STREAMS`, `RELAY_MAX_DVR_PER_IP`, `RELAY_MAX_HLS_INFLIGHT`, `RELAY_MAX_HLS_PER_IP` | 채팅 연결, 진행 중 WHEP 협상, 녹화 전송, HLS 요청의 전체·주소별 상한. |
| `RELAY_RATE_PUBLISH_IP`, `_ANNOUNCE`, `_AUTH_FAIL`, `_SESSION`, `_CHAT_CONNECT`, `_CHAT_SEND`, `_WHEP`, `_DVR`, `_STATS` | 토큰 버킷 `"burst/perSecond"`. 넘으면 429 + `Retry-After`. |
| `RELAY_RENDITIONS`, `RELAY_FFMPEG`, `RELAY_LADDER_IDLE_MS` | 중계 화질 래더(`"720p,480p"` 또는 `"480p:1.8"`): 방송마다 FFmpeg 하나, 읽는 사람이 없으면 5분 뒤 멈춤. 비우면 원본만. |
| `RELAY_HLS`, `RELAY_HLS_AAC` | HLS 사용, AAC가 없는 예전 송출 앱을 위한 Opus→AAC 변환 경로(`aac/`). |
| `RELAY_DVR`, `RELAY_RECORD_DIR` | 녹화 DVR. `dvr.m3u8`·`dvr/file`은 MediaMTX 녹화 폴더(`RELAY_RECORD_DIR`)가 있어야 합니다. |
| `RELAY_ICE_SERVERS`, `RELAY_TURN_URLS`, `RELAY_TURN_SECRET`, `RELAY_TURN_TTL_S` | `/info`의 ICE 서버와 짧은 수명 TURN 자격 증명(coturn use-auth-secret). |
| `RELAY_STATS_DIR`, `RELAY_STATS_MAX_MB`, `RELAY_STATS_KEEP_DAYS` | 재생 통계 CSV(하루 한 파일, 주소 저장 안 함). 비우면 받기만 하고 저장하지 않습니다. |
| `RELAY_UI_FILE`, `RELAY_JS_DIR`, `RELAY_FONTS_DIR` | 기존 단일 파일 시청 화면(`/`, `/{path}`)과 그 스크립트·글꼴. 설정한 파일만 읽습니다(Node처럼 `outputs/`를 기본으로 삼지 않음). 비우면 404. React 화면은 Caddy가 제공합니다(지금은 시험 설정 `deploy/test/Caddyfile.https-test`에만 있고, 운영 예시 `deploy/Caddyfile.example`에는 아직 없습니다). |
| `RELAY_LOG_LEVEL` | 이 백엔드 자체 로그의 수준(Tomcat·Spring 로그는 info 고정: 원문 요청의 토큰이 남지 않게). |

## 요청을 처리하는 곳

| 요청 | 받는 코드 | 규칙 |
| --- | --- | --- |
| `GET/PUT /api/obs/{obs-path}` | `obs/ObsController`, `obs/ObsBroadcasts` | OBS opt-in, 명시적 단독 경로 소유 토큰만 접근. 상태·송출 정보·제목, 미디어 도착/중단에 따른 자동 방송 등록·종료 |
| `POST /api/broadcasts/announce`, `PUT /api/broadcasts/{id}/thumbnail` | `broadcast/BroadcastController` | `BroadcastRegistry`(등록부: 토큰별 경로, 소유권, 경로 예약, 수명, 시작·종료 이벤트), `Announcement`(계약 v1 검증), `PublisherTokens` |
| `GET /api/broadcasts`, `GET /thumbnails/{id}.jpg` | `broadcast/BroadcastController` | 등록됐고 영상이 중계에 들어오는 방송만 목록에 올림 |
| `GET /{path}/info` | `playback/PlaybackController` | `LiveMedia`(경로의 방송 + MediaMTX 상태, 대기 판단), `Renditions`(화질 목록), TURN 자격 증명 |
| `GET /{path}[/b/{id}]/live.m3u8` | `playback/PlaybackController` | `LivePlaylist`(마스터 재생 목록), `BroadcastScope`(방송 ID 묶음, 대기 뒤 재확인) |
| `GET /{path}[/b/{id}][/{화질}|src|aac]/hls/{file}` | `playback/PlaybackController` | `HlsUpstream`(MediaMTX 공유 HLS 세션, 세션 ID 제거, 같은 요청 묶기, 파트 스트리밍), `quality/Ladders`(화질 래더 FFmpeg) |
| `POST /{path}[/b/{id}]/session`, `PUT/DELETE .../session/{sid}` | `playback/PlaybackController` | `Audience`(시청 상한: 세션 + WebRTC + 세션 없는 HLS), `ViewerSessions` |
| `POST|PATCH|DELETE /{path}[/{화질}]/whep[/{session}]` | `playback/WhepController` | 시청 상한과 `?b=` 방송 묶음을 HLS와 같게 적용, MediaMTX WebRTC로 전달 |
| `GET /{path}[/b/{id}]/dvr`, `dvr.m3u8`, `dvr/file[.mp4]`, `GET /{path}/dvr/media` | `dvr/DvrController` | `dvr/Recordings`(녹화 색인, 재생 서버 구간, HLS EVENT 재생 목록), `dvr/RecordFile`(fMP4 파싱, 키프레임 구간, 새 조각 만들기) |
| `WebSocket /{path}/chat` | `chat/ChatSocket` | `ChatGate`(연결 전 거절: 400/426/503/429/404, 슬롯 확인·회수), `ChatHandshakeFilter`(확장 없음, `Connection` 대소문자), `ChatHub`(방, 이름·글 규칙, 전송 제한, 기록) |
| `POST /{path}/stats` | `stats/StatsController` | `StatsLog`(익명 행, 하루 CSV, 용량·보관 기간) |
| `GET /`, `/{path}`, `[/{path}]/assets/js/{file}`, `[/{path}]/assets/fonts/{file}` | `page/LegacyPageController` | `RELAY_UI_FILE` 등 설정한 파일만 |
| `GET /healthz` | `HealthController` | MediaMTX API 연결 상태와 개수(시청자, 세션, 채팅, 소켓, 통계, 화질 인코더) |

테스트(`src/test`)는 규칙 단위 테스트와, 앱 전체를 띄워 확인하는 세 가지(`ShutdownTest` 종료 시간과 채팅 1001, `UpstreamBreakTest` 상위가 끊긴 응답의 연결 중단, `StartupGraceTest` 시작 유예)로 이루어집니다.

공통: `mediamtx/MediaMtxPaths`(MediaMTX 경로 목록, 초당 1회 갱신), `mediamtx/Deadline`(MediaMTX 요청 전체 기한), `mediamtx/BodyCopy`(본문 복사와 무응답 감시), `web/`(CORS·nosniff·소켓 상한 필터, 클라이언트 주소, 요청 제한, 동시 처리 상한, 응답 모양, Spring 자체 오류의 텍스트 응답, 반복 로그 억제, Node와 같은 숫자·문자 표기).

## 제품 포인트와 보상

로그인 시청자의 실제 재생 신호와 현재 HLS 세션을 확인해 채널별 유효 시청 60초당 비현금 10P를 적립합니다. PostgreSQL V11이 잔액·부분 누적·원장·보상·신청을 보존하고, 서버 경과 상한·페이지 sequence·지갑 잠금으로 긴 공백과 여러 탭의 중복 적립을 제한합니다. 보상 신청은 표시 가격 버전·잔액·차단·팔로우·방송당 한 번 제한을 확인하며, 거절·취소의 환불은 정확히 한 번 처리합니다. 토스 PG·충전·현금 결제와 연결하지 않습니다. API·멱등 재시도·권한·시청 신호의 한계는 [PRODUCT_API.md의 채널 포인트와 보상](PRODUCT_API.md#채널-포인트와-보상)을 따릅니다.

## 제품 질문과 답변

시청자는 로그인 계정으로 현재 방송에 질문을 보내고, 채널 소유자는 답변·고정·고정 해제를 합니다. 질문과 답변은 작성자와 소유자에게만 보이며 **고정 한 건만 전체 공개**합니다. PostgreSQL V10이 질문·요청 UUID·답변·버전을 보존합니다. 동일 요청 UUID 재전송은 새 질문을 만들지 않고, 계정당 새 질문 3건/60초와 채팅의 차단·팔로워·금칙어·링크 정책을 검사합니다. 방송 종료·교체·API 재시작 뒤에는 과거 질문·답변만 보존하고 공개 고정을 이어 붙이지 않습니다. 정확한 API·공개 범위·오류와 재시도 계약은 [PRODUCT_API.md의 질문과 답변](PRODUCT_API.md#질문과-답변)을 따릅니다.

## 이식 상태

- **1단계**: 송출 등록·썸네일·목록, `/info`, 방송 단위 경로의 `live.m3u8`·HLS, 시청 세션과 상한.
- **2단계**: 화질 래더, DVR, 채팅 WebSocket, WHEP, 재생 통계, 기존 `/{path}` 시청 화면과 경로 단위 미디어, 세션 없는 HLS 시청자 계수, TURN 자격 증명, 주소별 HLS·DVR·채팅 상한.
  - 응답 코드, 본문, 헤더, 요청 제한은 Node 중계와 같게 맞췄습니다.
  - Node와 다른 점: 채팅의 16 KB 초과 메시지는 Tomcat이 내용을 받은 뒤 1009로 닫습니다(Node는 프레임 머리만 보고 닫음). 그래서 중계 e2e는 실제 20 KB 메시지를 보내 확인합니다.
- **검증**: React e2e 34/34, 중계 e2e 108/108, Caddy 경유 HTTPS/WSS 18/0(미실행 2: Tailscale 인증서 필요), 배포 파일 점검 17/17을 Spring 대상으로 통과했습니다(`verification/spring/RESULTS.md`). 480p로 바꾼 직후의 간헐적 멈춤(두 백엔드 공통, 원인 미확인)은 같은 문서에 적었습니다.
- **배포**: `deploy/systemd/frame-relay.service`가 `java -jar /opt/frame-relay/frame-api.jar`로 실행합니다. 설치 절차와 JVM 옵션은 `deploy/README.md` 3·5장, 배포 파일과 jar가 맞는지는 `node server/verify/deploy-check.mjs`로 확인합니다.
- **남은 일**: Linux 서버에서의 실제 실행(systemd, 패키지 Java), Tailscale 인증서 Caddy 실행과 휴대폰 확인, 운영 Caddy 예시에 React 화면 추가, 480p 전환 직후 멈춤의 원인.

## 종료와 재시작

### 로컬 토스 테스트 결제

`payments/`는 테스트 키만 사용하는 주문 생성·승인·내역 조회를 제공한다. 로컬 운영자 인증, 서버 저장 금액 검증, 승인 전 멱등키 저장, 중복 승인 방지를 적용했다. 시크릿·보안 키는 서버 전용 설정에서만 읽는다. 사용 방법과 현재 지원 범위는 [deploy/TOSS_TEST.md](../../deploy/TOSS_TEST.md)를 따른다. 인터넷 서비스의 고객 계정 인증·환불·정산·웹훅 API는 별도 단계다.

- SIGTERM(`systemctl restart`)을 받으면 먼저 채팅 참가자에게 1001(서버가 떠남)로 닫는다고 알리고(`ChatSocket`이 가장 먼저 멈춤), 진행 중인 요청을 최대 2초 기다린 뒤(`spring.lifecycle.timeout-per-shutdown-phase`) 끝냅니다. 화질 래더 FFmpeg는 함께 끝납니다. 종료 코드는 143입니다(Linux의 SIGTERM 기준이고 이 PC에서는 실행하지 못했습니다. `ShutdownTest`가 잰 것은 2초 대기와 채팅 1001입니다).
  - 시청자의 블로킹 재생 목록 요청 하나가 MediaMTX에 15초까지 잡혀 있을 수 있어서, 이 상한이 없으면 재시작이 그만큼 늦어집니다. 측정: 요청 하나를 잡아 둔 상태에서 종료 4.3 s(`ShutdownTest`). 상한을 넣기 전에는 15.1 s였습니다(기록 파일 없음, 당시 실행 출력).
- 방송 목록과 채팅방은 메모리에 있습니다. 재시작하면 송출 앱의 다음 등록(2초 이내)으로 목록이 돌아오고 채팅 기록은 비워집니다.
- **시작 유예 5초**(`LiveMedia.STARTUP_GRACE_MS`): 시작 직후에는 목록이 아직 비어 있으므로, 방송이 없는 경로의 시청 요청(`/info`, 방송 단위 경로, 세션, WHEP, DVR)에 "방송 없음" 대신 `503 + Retry-After: 2`("... media is not ready yet")로 답합니다. 두 시청 화면 모두 "방송 없음"을 방송 종료로 받아들이기 때문입니다. 그래서 재생 중이던 화면은 재시작 뒤 기다렸다가 스스로 이어서 재생합니다(`StartupGraceTest`, Caddy 경유 검사 H10). 이전 Node 중계에는 없던 동작이고, 유예가 지나면 이전과 같이 답합니다. 채팅 연결과 목록(`/api/broadcasts`)에는 적용하지 않습니다.
- MediaMTX가 응답 본문 도중에 끊기면(재시작, 송출 중단) 시청자 연결을 끊습니다. 잘린 파트·녹화 조각이 정상 응답처럼 끝나지 않게 하려는 것이고, Spring MVC 밖의 필터(`WebDefaults`)에서 끊습니다(`Replies.abort`, `UpstreamBreakTest`).

## 저장소 메모

- `gradlew`는 실행 권한이 있어야 합니다. 이 Windows 작업 폴더는 `core.fileMode=false`라서, 커밋할 때 `git add --chmod=+x apps/api/gradlew`로 올립니다.

## 무료 미션

로그인한 시청자가 현재 방송에 무료 미션을 제안하고, 방송자가 수락·완료·실패·거절·취소를 처리합니다. 제안과 결과는 제안자와 방송자만 조회합니다. V12가 제안·상태 버전·전이 이력을 보존하며 접수부터 15/30/60분 기한과 방송 종료·교체·재시작 만료를 서버에서 판단합니다. 만료를 관측한 요청이 409로 거절되어도 만료 이력은 남고 최종 상태를 다시 열지 않습니다. 금전·포인트 차감이나 보상 지급에 연결하지 않습니다. [무료 미션 API 계약](PRODUCT_API.md#무료-미션과-진행-이력)을 따릅니다.

## 방송 분석

제품 기능을 켜면 전용 worker가 실제 fresh 송출과 활성 시청 세션을 5초 간격으로 관찰해 PostgreSQL V13의 방송별·한국 날짜별 집계에 저장합니다. 소유자 전용 `GET /api/v1/me/analytics`는 7/30일·검색·날짜·cursor와 방송 수·관찰한 송출 시간·평균/최고 추정 동시접속 수를 제공합니다. 수집 전/중단 구간은 보간하지 않고, API 재시작 시 이전 진행 행은 마지막 관찰 시각으로 중단 처리합니다. 고유 시청자 수나 실제 재생 시간의 증명이 아닙니다. 짧은 OBS 재접속은 동일 instance의 집계를 재개하고 최초 새 관찰 사이 간격은 누적하지 않습니다. 정확한 정의와 현재 단일 API 배치의 한계는 [방송 분석 API 계약](PRODUCT_API.md#방송-분석)을 따릅니다.

## 비공개 녹화 관리

제품 모드에서 서버 fMP4 파일을 소유자만 조회·재생·내려받고 목록에서 숨기거나 복원합니다. V14의 관찰 창과 파일 카탈로그가 실제 확인한 귀속만 보존하며, 공개 다시보기 발행·원본 삭제·보관 설정 변경은 포함하지 않습니다. 같은 방송에 전체가 속한다고 확인한 완료 파일만 전달하므로 짧은 방송의 첫·마지막 파일은 누락되거나 제한될 수 있습니다. 기존 MediaMTX 녹화·DVR 출력은 보존합니다. 상태·기대 계정·Range/HEAD·기본 6시간 보관과 경계는 [비공개 녹화 API 계약](PRODUCT_API.md#비공개-녹화-관리)을 따릅니다.

## 검증

```bash
node server/verify/web-e2e.mjs --backend spring   # React 시청 화면 전체(목록, 재생, 화질, 채팅, DVR, 방송 교체 ...), 포트 25xxx
node server/verify/e2e.mjs --backend spring       # 중계 계약 전체(기존 화면, DVR, 채팅 규칙, 상한, 장애), 포트 24xxx
node server/verify/spring-app-check.mjs           # 실제 송출 앱 -> Spring -> React 재생 -> 종료, 포트 27xxx
node server/verify/chat-load.mjs --clients 1000 --senders 2 --messages 5 --backend spring   # 채팅 1,000 연결
node server/verify/deploy-check.mjs               # deploy/의 단위 파일·환경 예시·설치 절차와 jar의 정합(Linux 없이), 포트 28080
node server/verify/https-session.mjs --host <test-host> --tls internal --bind <주소> --backend spring   # Caddy 경유 시험 세션
node server/verify/https-check.mjs                # 그 세션에서 HTTPS/WSS, 재생, 채팅, 서비스 재시작(H10)
```

결과는 `verification/spring/RESULTS.md`에 있습니다.
