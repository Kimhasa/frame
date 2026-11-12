# Spring 백엔드 검증 (2026-11-10)

범위: Node 중계(`server/relay.mjs`)의 기능 전체를 Spring Boot 백엔드(`apps/api`)로 옮기고, 기존 검증을 Spring을 실제 대상으로 실행했습니다. 이 PC 한 대의 루프백 측정입니다(Caddy 검증만 이 PC의 tailnet 주소).
- 도구: JDK 21.0.13, Spring Boot 4.1.2, MediaMTX 1.21.3, FFmpeg 9.0.2, Edge 157(headless), Caddy v2.11.9.
- 같은 PC에서 메이플스토리 실행 중. 무거운 검증은 한 번에 하나씩 돌렸습니다.

## 실행 명령

```bash
(cd apps/api && ./gradlew test bootJar)        # JAVA_HOME = JDK 21
export JDK_JAVA_OPTIONS="-Xmx256m -XX:+ExitOnOutOfMemoryError"   # 배포 전환 결과의 Spring 실행에 쓴 값(스크립트는 -Xms64m만 준다)
node server/verify/web-e2e.mjs --backend spring
node server/verify/e2e.mjs --backend spring
node server/verify/https-session.mjs --host <test-host> --tls internal --bind <tailnet IPv4> --backend spring
node server/verify/https-check.mjs
node server/verify/https-session.mjs --stop
node server/verify/chat-load.mjs --clients 1000 --senders 2 --messages 5 --backend spring
node server/verify/deploy-check.mjs            # 배포 파일과 jar의 정합, 잘못된 설정값의 시작 거부
node server/verify/spring-app-check.mjs        # 1단계 결과(아래)
```

## 배포 전환 결과: Node → Spring (2026-11-10)

배포 설정(`deploy/`)이 `frame-api.jar`를 실행하도록 바꾸면서 다시 확인한 것입니다. 아래는 모두 **최종 jar**로 실행한 값이고, 아래 "2단계 결과"의
증거 파일(`web-e2e-result.json`, `relay/`, `caddy/`)은 이 실행들로 덮어썼습니다. Linux·systemd는 이 PC에서 실행할 수 없어(WSL·Docker 없음)
문서와 소스 조사로 대신했고, "미실행"에 적었습니다. Spring 대상 실행은 `JDK_JAVA_OPTIONS="-Xmx256m -XX:+ExitOnOutOfMemoryError"`로 돌렸습니다("힙 256 MB". 스크립트가 여기에 `-Xms64m`을 더합니다).

| 검증 | 결과 | 내용 |
| --- | --- | --- |
| 단위·통합 테스트(`apps/api/src/test`) | 41/41 통과 | 추가: 종료 시간과 채팅 1001(`ShutdownTest`), 상위가 끊긴 응답의 연결 중단(`UpstreamBreakTest`), 시작 유예(`StartupGraceTest`) |
| 배포 파일 점검(`deploy-check.mjs`) | 17/17 통과 | 배포 파일이 LF, 단위 파일·환경 예시·설치 절차의 경로 일치. `relay.env.example`의 값으로(경로·포트·MediaMTX API 주소만 바꿔) jar가 설정 경고 없이 시작(2.077 s, MediaMTX 미연결 경고는 제외), `JDK_JAVA_OPTIONS` 적용, 루프백에서만 수신, 설치한 화면·스크립트·글꼴, 토큰 파일, 통계 CSV. 잘못된 값(범위 밖, rate 형식, 스위치 형식)은 시작을 막고 로그에 이름이 나옴, `on`/`off`는 스위치로 읽힘 |
| 중계 e2e, Spring(힙 256 MB) | 108/108 통과, 127 s | 프로세스 메모리 최대 245 MB(전용 298 MB), 스레드 69개 |
| 중계 e2e, Node(비교 기준) | 108/108 통과, 120 s | 바꾼 검사(20 KB 채팅 메시지는 1009, 마스크 없는 프레임은 1002로 닫힘)가 Node에서도 통과. 프로세스 메모리 최대 76 MB. 같은 날 앞선 1회는 107/108(기록 파일 없음, 당시 실행 출력. 아래 "480p 전환") |
| React e2e, Spring(힙 256 MB) | 34/34 통과, 237 s | 목록 → 재생 → 화질 → 채팅 → DVR → 방송 교체 → 재접속 → 대기 → 상한 → 403 → 정리 → WHEP |
| 채팅 1,000 연결, Spring(힙 256 MB) | 1,000/1,000 입장 5.1 s | 10,000건 전달 모두 수신, 전달 p50 21 ms / p95 42 ms, 입장 직후 프로세스 메모리 303 MB. Node(2026-10-28): p50 55 / p95 233 ms, 입장 직후 74 MB |
| Caddy 경유, Spring(힙 256 MB) | 18 통과, 실패 0, 미실행 2 | 기존 17개 + 재시작 검사 H10(아래). 미실행 2건은 Tailscale 인증서가 있어야 하는 B1·H1b |
| Caddy 경유, Node(비교 기준) | 18 통과, 실패 0, 미실행 2 | 같은 검사. H10은 Node에서 기록만(열린 화면의 복귀는 요구하지 않음) |

### 재시작(H10): 서비스를 끄고 다시 띄울 때 시청자가 보는 것

시험 세션에서 중계 웹 서비스를 죽이고 같은 설정으로 다시 띄웠습니다(Caddy와 MediaMTX, 송출은 그대로). 1회 실행값입니다.

| | Spring(시작 유예 5 s) | Node(이전 중계) |
| --- | --- | --- |
| `/healthz`가 다시 답할 때까지 | 6.4 s | 0.2 s |
| Caddy가 502로 답한 시간 | 5.7 s | 0.1 s |
| 목록에 방송이 다시 보일 때까지 | 8.1 s | 1.8 s |
| 재생 중이던 React 화면 | ready → reconnecting → waiting → ready: 16.3 s 뒤 스스로 재생, 채팅 재접속 됨. 그동안 화면 문구: "방송에 다시 연결하는 중이에요", "방송 신호를 기다리고 있어요" | ready → ended: "방송이 종료됐어요"로 끝남, 새로 고쳐야 함 |
| 기존 `/<path>` 화면 | 스스로 다시 재생 | 스스로 돌아오지 못함 |
| 새로 연 화면 | 재생 | 재생 |

- "스스로 재생"까지의 시간은 열려 있던 화면이 다시 재생 상태(문구 없음, 영상 진행)가 된 순간까지입니다. 끄는 순간부터 잽니다.
- 실행마다 달라지는 값입니다. 같은 날 바로 앞 실행에서는 Spring의 `/healthz` 복귀 3.1 s, 502 구간 2.7 s, 목록 3.6 s, 화면 복귀 11.7 s였습니다(그 결과 파일은 이 실행으로 덮어썼습니다). 이번 실행은 서비스가 꺼진 동안 20 ms 간격으로 조회하도록 검사를 바꾼 뒤의 값이고, 같은 PC의 부하도 달랐습니다.
- Node는 빨리 뜨지만, 방송 목록이 메모리에 있어 다음 등록(2초 이내)까지 "방송 없음"으로 답했고 열려 있던 화면은 그것을 방송 종료로 받아들였습니다. 이전부터 있던 동작입니다.
- Spring은 JVM 기동 때문에 몇 초 더 늦게 뜹니다. 그래서 시작 뒤 5초 동안은 "방송 없음" 대신 `503 + Retry-After`로 답하게 했고(시작 유예, Node에는 없던 동작), 열려 있던 화면이 새로 고침 없이 이어집니다. 유예를 넣기 전 jar로는 두 번 중 한 번 "방송이 종료됐어요"로 끝났습니다(기록 파일 없음, 당시 실행 출력).
- 서비스 종료 쪽: 진행 중 요청을 최대 2초만 기다립니다. 요청 하나를 잡아 둔 상태에서 종료 4.3 s, 채팅은 1001로 닫힘(`ShutdownTest`). 설정 전에는 15.1 s, 1006이었습니다(기록 파일 없음, 당시 실행 출력).

### 이번에 찾아 고친 것

- **상위가 끊긴 미디어 응답이 정상처럼 끝나던 문제(1단계부터 있었고, "실행해 보지 못함"으로 적어 둔 부분).** MediaMTX가 파트·녹화 조각 전송 중에 끊기면 시청자는 잘린 본문 뒤에 `Internal error` 글자가 붙고 정상 종료된 200 응답(`max-age=60`)을 받았습니다. Spring MVC가 연결 중단 예외를 가로채 500 처리기로 넘겼기 때문입니다. 이제 Spring 밖의 필터에서 연결을 끊습니다: 끊긴 뒤 0.3 s 안에 연결 종료, 종료 청크와 오류 글자 없음(`UpstreamBreakTest`, HLS 파트와 `dvr/media`).
- 종료가 시청자 요청 하나에 15초까지 잡히던 점, 종료 때 채팅이 비정상 종료(1006)로 끊기던 점.
- 재시작 직후 "방송 없음" 응답(위 시작 유예). WHEP의 `?b=` 요청에도 같은 유예를 적용했고, 유예 시간은 시계 변경에 영향받지 않는 값으로 잽니다.
- 시청자가 스스로 끊은 전송을 녹화·상위 오류로 기록하던 로그 분류.
- 서버 로캘에 따라 달라질 수 있는 소문자 변환 4곳(`Locale.ROOT`), SIGTERM을 무시하는 FFmpeg의 강제 종료(유휴 정지는 5초 뒤, 서비스 종료는 2초 뒤), 서비스 종료 때의 래더 경고 로그 제거, 읽기 전용 상위 폴더 아래 통계 폴더 처리.
- `RELAY_RATE_*`와 `RELAY_ICE_SERVERS`의 형식 오류가 변수 이름 없이 나오던 시작 오류 문구.
- 검증 스크립트: `--backend=spring`처럼 잘못 쓰면 Node 중계를 대신 돌리던 점, `https-check.mjs`가 실패해도 종료 코드 0이던 점, 채팅 큰 메시지·마스크 없는 프레임 검사가 닫힘 코드를 보지 않던 점, 결과 파일에 PC 이름·계정 경로가 남던 점.

### 480p 전환 직후의 간헐적 멈춤

Caddy 경유 검사의 "480p로 바꾼 뒤에도 재생이 이어짐"(H4a)이 오늘 Spring 대상 7회 중 2회 실패했고, Node 대상 중계 e2e의 같은 종류 검사도 1회 실패했습니다(두 수치 모두 기록 파일 없음, 당시 실행 출력). 그래서 같은 세션에서 전환을 반복해 두 백엔드를 비교했습니다(`caddy/quality-switch-ab.json`).
- 전환 뒤 3초 동안 재생이 1.5초 이하로 진행된 횟수: Spring 3/26, Node 1/26(Node는 2초 미만이 2회 더).
- 멈춘 전환을 포함해 모든 전환에서 중계의 480p 재생 목록·첫 미디어 응답은 두 백엔드 모두 10~20 ms 안에 나갔습니다(Caddy 접근 로그). 중계 응답 지연이 원인이 아닙니다.
- 두 백엔드 모두에서 나오는 간헐 현상이고, 이 표본으로는 백엔드 차이를 말할 수 없습니다. 원인은 확인하지 못했습니다(화질 전환 시 플레이어 동작, 같은 PC에서 도는 480p 인코더의 타이밍이 후보). 배포 README 11장의 2026-11-02 기록에도 같은 종류의 멈춤이 있습니다.

### 서버 쪽 조사(문서·소스 확인, 실행 없음)

- systemd 단위: `SuccessExitStatus=143`(JVM의 SIGTERM 종료 코드), `TimeoutStopSec=10`, `KillMode=control-group`(FFmpeg 자식 정리), 기존 샌드박스 지시문은 JVM과 함께 쓸 수 있음(임시 폴더는 `PrivateTmp`), `MemoryDenyWriteExecute`는 넣지 않음.
- Java 21 런타임: Ubuntu 22.04·24.04, Debian 13은 `openjdk-21-jre-headless`, Debian 12는 Eclipse Temurin. JVM 옵션은 `relay.env`의 `JDK_JAVA_OPTIONS`.
- 화질 래더는 FFmpeg 6.1 이상이 필요(`-enc_time_base:v filter`). 다시보기 녹화도 FFmpeg가 있어야 함(MediaMTX의 복사 명령). Java 패키지를 올린 뒤에는 서비스를 재시작해야 FFmpeg를 띄울 수 있음(`jspawnhelper` 버전 확인).

## 2단계 결과: 화질·DVR·채팅·WHEP·통계·기존 화면

아래 수치는 독립 검토의 수정을 반영한 최종 jar로 다시 실행한 결과입니다(수정 전 첫 실행도 같은 항목이 모두 통과: 34/34, 108/108, 17/0/2).

| 검증 | 결과 | 내용 |
| --- | --- | --- |
| 단위 테스트(`apps/api/src/test`) | 38/38 통과 | 1단계 23개(시그니처 변경 반영) + 화질 래더 마스터 재생 목록(`src/`, 480p 854×480, 래더 실패 시 원본 경로), 세션의 주소 이동, 녹화 파일 이름의 시각, `Range` 해석, 합성 fMP4로 키프레임 구간 자르기·새 조각 만들기·EVENT 재생 목록·보관 기간 삭제 뒤 `MEDIA-SEQUENCE`, 채팅 이름·글 규칙과 방 수명·8개/10초 제한, 통계 행(숫자 표기, 수식 무력화, CSV 따옴표), 검토 수정(짝 없는 서로게이트, `toFixed` 반올림, JSON 숫자 표기, 이상한 시간대 이름, `Connection: UPGRADE`) |
| React e2e 전체(`web-e2e.mjs --backend spring`, 포트 25xxx) | 34/34 통과, 237 s | 목록, 재생, 화질 480p↔자동, 채팅(다른 출처 페이지 1번 수신), DVR 되감기·실시간 복귀, 방송 교체(옛 링크는 새 방송을 받지 않음), MediaMTX 재시작 뒤 복구, 송출 대기, 시청 상한, 403, 정리, WHEP 대체 재생과 상한. Node 대상 실행(2026-11-09)도 34/34, 233 s |
| 중계 e2e 전체(`e2e.mjs --backend spring`, 포트 24xxx) | 108/108 통과, 131 s | 기존 단일 파일 화면(`/screen-01`), RTSPS 송출 계정, 등록·썸네일, `/info`(TURN, 화질, HLS), DVR 색인·구간·`dvr.m3u8`·`dvr/file` Range·구간 조각, LL-HLS 블로킹 재요청, 원본과 480p 같은 타임라인(PDT 차 0 ms), 통계 CSV, 방송 단위 경로와 경로 재사용, AAC 없는 예전 송출 앱, 채팅 규칙 전체, RFC 6455 경계, 시청·채팅·소켓 상한, 미디어 대기, MediaMTX API 정지 시 마지막 목록 유지, 요청 폭주 제한, Edge HTTP·HTTPS 재생, ws↔wss 채팅. Node 대상 실행(2026-11-09)도 108/108, 118 s |
| Caddy 경유 HTTPS/WSS(`https-check.mjs`, Spring 뒤) | 17 통과, 실패 0, 미실행 2, 35 s | `caddy validate`, 정적 파일, 중계 전달(기존 `/screen-01` 화면 포함), 내부 주소 노출 0건, 503 + `Retry-After` 전달, WSS 업그레이드 101, Edge로 목록→재생(첫 프레임 2.0 s, 지연 1.8 s)→480p(0.9 s)→자동→46 s 되감기→실시간 복귀(지연 1.4 s), WSS 채팅(124 ms 뒤 1번 수신), `caddy reload`로 끊긴 채팅 1.3 s 뒤 재접속(중복 0), 요청 549건 모두 https(h2 535건). Node 사전 실행(2026-11-09)과 같은 항목 |

- 첫 프레임 7.9 s(React e2e 2단계): 화질 래더가 원본 사본(`src/`)을 처음 낼 때까지의 시간입니다. 같은 래더 설정의 Node 실행도 7.9 s였습니다. 1단계의 1.7 s는 래더 없이 잰 값입니다.
- 채팅의 16 KB 초과 메시지: Node는 프레임 머리만 보고 닫고, Tomcat은 내용을 받은 뒤 1009로 닫습니다. 그래서 중계 e2e의 이 항목은 실제 20 KB 메시지를 보내도록 바꿨습니다(두 백엔드 모두 통과하는 방식).
- Spring은 `RELAY_UI_FILE`을 기본값 없이 읽습니다(다른 앱 폴더를 스스로 읽지 않음). 검증 스크립트가 `outputs/index.html`을 넘깁니다.
- 경고 로그는 의도한 시험 상황에서만 나왔습니다. 지금 `relay/logs/relay.log`(2026-11-10 배포 전환 실행)의 경고는 2줄입니다: 틀린 토큰의 등록 거부, MediaMTX 재시작 때 화질 인코더 종료(몇 초 뒤 다시 시작).
- 증거 파일: `web-e2e-result.json`, `web-*.png`, `relay/e2e-result.json`, `relay/*.m3u8`, `relay/*.png`, `relay/stats-sample.csv`, `caddy/https-check-result.json`, `caddy/*.png`, `logs/`, `relay/logs/`(비밀 값은 가림). 이 파일들은 지금 2026-11-10 배포 전환 실행의 값을 담고 있어 위 표의 수치와 다릅니다. `*.log`는 `.gitignore` 대상이라 저장소에는 올라가지 않습니다(로컬 증거). Node 대상 증거는 `deploy/verification/`, `verification/web/`, `verification/caddy/`에 그대로 있습니다.

## 2단계 독립 검토

새 코드를 두 관점(DVR, 채팅·WHEP·통계·기존 화면)에서 Node 원본과 대조해 읽기 전용으로 검토했습니다. 지적 19건 중 17건을 고쳤고, 고친 뒤 단위 테스트와 세 e2e를 다시 실행했습니다(위 표의 수치).
- 안정성·보안
  - 채팅에 짝 없는 서로게이트(`"\ud800"`)를 보내면 Tomcat의 UTF-8 인코더가 실패해 방 전체가 끊기던 문제. 나가는 글은 U+FFFD로 바꿉니다(통계 CSV도 같음).
  - 101 응답이 상대에게 가지 못하면 채팅 슬롯이 영구히 줄던 문제. 슬롯을 소켓 열림으로 확인하고, 확인되지 않은 슬롯은 30 s 뒤 회수합니다.
  - WHEP의 시청 상한 확인과 예약 사이 틈(동시 요청이 함께 통과). 세션 상한과 같은 잠금 안에서 한 번에 처리합니다.
  - 채팅 소켓이 브라우저의 permessage-deflate를 받아들이던 점(소켓마다 zlib 상태, 상한 2,000개에서 수백 MB). Node처럼 확장 없이 연결합니다.
  - WHEP 응답 본문에 기한이 없던 점(20 s 전체 기한으로), 녹화 폴더의 이상한 파일 이름 하나가 그 경로의 DVR 전체를 500으로 만들던 점.
- 정합성
  - 공개 캐시(`max-age=3600`)되는 `dvr/file` 응답이 이전 길이를 담을 수 있던 읽기 순서.
  - 녹화·미디어 전송이 첫 바이트 전에 실패하면 Tomcat 500 페이지가 나가던 점. 이제 Node처럼 연결을 끊습니다.
  - Java 21 가상 스레드가 DVR 파일 잠금(모니터)에서 운반 스레드를 붙잡던 점. `ReentrantLock`으로 바꾸고 조각 만들기는 잠금 밖에서 합니다.
  - JSON 숫자의 과학 표기(`1.76E12`), `toFixed` 반올림 차이, 64비트 상자 크기 넘침, 채팅 방 이벤트 순서, 여러 개의 `Link` 헤더, 줄 끝 문자 앞의 공백 제거, `Connection: UPGRADE` 거절, 잘못된 경로 POST의 405, 형식이 틀린 방송 접두사의 404.
- 그대로 둔 것(의미가 같음): `Content-Type` 표기(Tomcat이 `;charset=UTF-8`로 정규화), 400 응답의 `Connection: close`(Tomcat이 400에서 연결을 닫음), `/healthz`의 `backend` 키와 버전 문자열, Tomcat의 16 KB 메시지 한도가 UTF-16 단위인 점(글 1,000자 제한은 같음).

## 1단계 결과: 등록 → 목록 → 재생

| 검증 | 결과 | 내용 |
| --- | --- | --- |
| 기존 React e2e 1·2단계, Spring 대상 | 8/8 통과, 15 s | 시험 송출과 2초 등록 → 빈 목록과 목록 오류 구분 → 카드 → 시청 화면. hls.js 1280×720, 소리 디코딩, 첫 프레임 1.7 s(래더 없음) |
| 실제 송출 앱(`dist/FrameConsole/FrameConsole.exe`) → Spring(포트 27xxx) | 4/4 통과, 32 s | 앱이 RTSPS로 송출하고 Spring에 등록 → 3.2 s 뒤 목록에 표시(1920×1080 60 fps). React가 hls.js로 재생. 앱에서 송출 종료 → 0.7 s 만에 목록에서 빠짐 |

- 실제 앱 시험 전후로 앱 설정(`config/frame-console.json`, 비밀 파일)을 백업·복구했고, 시험 후 해시가 같습니다. 앱 설정이 `audio: none`이라(게임 소리를 잡지 않으려고 그대로 둠) 실제 앱 시험은 영상만 확인했습니다.
- 1단계 독립 검토: 지적 26건 중 확인된 16건을 고친 뒤 다시 실행했습니다(보안 3, 정합성 7, 운영 6).

## 미실행

- Tailscale 인증서로 하는 Caddy 실행(브라우저·Windows·Node 기본 신뢰, B1·H1b)과 휴대폰 실기기(iPhone Safari, Android Chrome): 사용자가 tailnet HTTPS 인증서를 켠 뒤 진행합니다.
- 인터넷 회선, 장시간 운영, 1,000명 부하: 이번 수치는 모두 이 PC의 루프백·tailnet 측정입니다.
- 실제 송출 앱으로 하는 2단계 기능 시험(채팅·DVR 등): 송출 앱과의 계약은 1단계 앱 시험과 같고, 2단계 기능은 FFmpeg 시험 송출로 확인했습니다.
- Linux 서버에서의 실행 전체: systemd 단위(샌드박스 아래 JVM 기동, 종료 코드 143, 실제 종료 시간, FFmpeg 자식 정리), 배포판 Java 21 패키지, 운영 `Caddyfile.example`. 이 PC에는 Linux가 없어 문서·소스 조사와 `deploy-check.mjs`까지만 했습니다.
- 작은 VM에서 JVM의 메모리와 기동 시간, 실제 시청 부하에서의 힙 사용.
- 운영 `deploy/Caddyfile.example`은 실행하지 않았고, React 공개 웹(`/_frame/`)을 아직 제공하지 않습니다(시험 설정 `deploy/test/Caddyfile.https-test`에만 있음).
- 480p로 바꾼 직후의 간헐적 멈춤은 원인을 찾지 못했습니다(위 "480p 전환 직후의 간헐적 멈춤").
- 실제 송출 앱 시험(`spring-app-check.mjs`)은 이번 전환에서 다시 돌리지 않았습니다. 그 스크립트가 앱의 송출자 이름을 고정 값으로 주도록 바꾼 것(결과 화면에 PC 이름이 나오지 않게)은 실행으로 확인하지 않았습니다. 기존 결과 파일과 목록 화면의 PC 이름은 가렸습니다.
- 실제 서버 배포와 커밋은 하지 않았습니다. 배포 설정 파일만 바꿨습니다.
