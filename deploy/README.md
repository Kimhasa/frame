# FRAME 인터넷 중계 서버 배포 안내

다른 인터넷 회선의 시청자가 브라우저만으로 방송을 보도록, OBS 또는 기존 Windows 송출 앱의 영상을 받는 **중계 서버**의 구성·설치·운영 절차다.
설계 이유는 [DESIGN.md](DESIGN.md), 로컬 재현 결과는 [verification/](verification/)(이전 Node 중계)와
[../verification/spring/RESULTS.md](../verification/spring/RESULTS.md)(지금 배포하는 Spring 백엔드)에 있다.

**OBS 입력(2026-11-11)**: 기존 C++ 앱은 보존한다. OBS용 RTMP/RTMPS 입력·자동 방송 등록·PC 시험 설정은 [OBS.md](OBS.md)에 별도로 정리했다. 아래 기존 Windows 앱 경로는 그대로 사용할 수 있다.

**2026-11-10: 중계 웹 서비스를 Node(`server/relay.mjs`)에서 Spring Boot(`apps/api`의 `frame-api.jar`)로 바꿨다.** 주소·JSON·헤더·
설정 변수(`RELAY_*`)는 그대로이고, 바뀐 것은 실행 파일(`node` → `java -jar`)과 서버에 필요한 런타임(Node.js → Java 21)이다.
이 문서의 "relay"는 그 중계 웹 서비스를 가리킨다. Node 구현은 배포하지 않고 검증의 비교 기준으로만 저장소에 남아 있다.

> 상태: 이 저장소에서 **로컬 PC(루프백)로만** 재현·검증했다. 실제 인터넷 배포, 다른 회선, 실제 TURN, 실제 휴대폰, 1,000명
> 동시 시청은 **미검증**이다. 공개 접속 완료로 표시하지 않는다.

## 1. 구성

```
 Windows 송출 PC (FrameConsole.exe)                         중계 서버 (Linux, 공인 IP)
 ┌───────────────────────────────┐   RTSPS :8322 (TLS,    ┌──────────────────────────────────────────────┐
 │ FFmpeg ─RTSP→ 로컬 MediaMTX ──┼── 송출 계정) ─────────▶│ MediaMTX (mediamtx-relay.yml)                │
 │                  │ (LAN 시청 그대로)│                    │  ├ 녹화(DVR) /var/lib/frame-relay/recordings │
 │ 방송 등록·썸네일 ──────────────┼── HTTPS + Bearer ──┐   │  ├ WebRTC ICE  UDP/TCP :8189 ◀──── 브라우저 미디어
 └───────────────────────────────┘                     │   │  └ API·playback·HLS·WHEP HTTP: 127.0.0.1 전용  │
                                                       │   │ frame-api 127.0.0.1:8080 ◀─ Caddy :443 ◀── 브라우저
                                                       └──▶│  (UI, 목록, /info, WHEP·HLS·DVR 중계, 채팅 WSS) │
                                                           └──────────────────────────────────────────────┘
```

- 브라우저는 `https://<도메인>/` 하나만 연다. 화면(outputs/index.html)과 API는 송출 PC 내부 시청 서버와 같은 경로·JSON이라
  UI 코드는 그대로다(목록의 `baseUrl`이 중계 서버 주소로 바뀔 뿐).
- **일반 시청은 LL-HLS**다: 브라우저는 `/<path>/live.m3u8`(relay가 만드는 화질 목록, 화질마다 영상 + AAC)을 hls.js 1.5.20
  (`/assets/js/hls-1.5.20.min.js`, relay가 서비스) 또는 Safari 기본 HLS로 재생하고, 다시보기는 `/<path>/dvr.m3u8`이다.
  WebRTC(WHEP)는 데스크톱 앱 수신과 HLS를 전혀 못 쓰는 브라우저에만 쓴다. HLS 응답에는 시청자별 값·쿠키가 없어 CDN에
  얹을 수 있다(9장).
- 송출 PC의 사설 IP, localhost, MediaMTX 관리 주소는 브라우저에 전달되지 않는다. 중계 MediaMTX의 API·녹화 조회·송출 기능도
  브라우저 쪽에서는 닿지 않는다(중계 웹 서비스가 경로를 검사한 뒤 루프백으로만 넘김).

## 2. 파일

| 파일 | 용도 |
|---|---|
| `../apps/api/` → `frame-api.jar` | 중계 웹 서비스(Spring Boot, Java 21 이상). 빌드: `cd apps/api && ./gradlew bootJar` → `build/libs/frame-api.jar`([../apps/api/README.md](../apps/api/README.md)) |
| `../server/relay.mjs`, `../server/lib/*.mjs` | 이전 Node 중계. 배포하지 않는다. 검증 스크립트의 비교 기준(`--backend node`, 기본값)으로만 둔다 |
| `mediamtx-relay.yml` | 중계 MediaMTX 1.21.3 설정(비밀 없음, 환경변수로 덮어씀) |
| `mediamtx.env.example` | MediaMTX 비밀·공인 주소·인증서 경로 예시 |
| `relay.env.example` | 중계 웹 서비스 설정과 JVM 옵션 예시(토큰은 파일로) |
| `Caddyfile.example` | HTTPS·WSS 역방향 프록시(인증서 자동) |
| `systemd/*.service` | 두 서비스의 systemd 단위 예시 |
| `../server/tls-front.mjs` | 로컬 검증용 HTTPS 앞단(Caddy 대용, 운영에 쓰지 않음) |
| `../server/verify/e2e.mjs`, `chat-load.mjs` | 로컬 재현 검증 스크립트(`--backend spring`이 배포하는 백엔드) |
| `../server/verify/deploy-check.mjs` | 이 폴더의 단위 파일·환경 예시·설치 절차가 서로 맞는지, `relay.env.example` 그대로 jar가 뜨는지 확인(Linux 없이) |

## 3. 서버 요구 사항

- Linux x86_64 또는 arm64, **공인 IPv4**(1:1 NAT 클라우드 VM이면 `MTX_WEBRTCADDITIONALHOSTS`에 공인 IP), UDP 수신 가능.
- 중계만 할 때(서버 측 화질 인코더 없음): 2 vCPU, RAM 2 GB 이상을 출발점으로 둔다. **실측 근거 없음** — 단계 부하 측정으로 정한다.
- 중계 웹 서비스(JVM)의 메모리는 이전 Node 중계보다 크다. 이 PC(Windows, JDK 21.0.13)에서 힙 상한 256 MB(`-Xmx256m`)로 중계 e2e
  전체와 채팅 1,000 연결이 통과했고, 프로세스 메모리(작업 집합)는 e2e 동안 최대 245 MB(전용 바이트 298 MB), 채팅 1,000 연결 직후
  303 MB였다. Node 중계는 같은 e2e에서 최대 76 MB, 채팅 1,000 연결 직후 74 MB(2026-10-28)였다
  (`../verification/spring/deploy/memory.json`). Linux 서버와 실제 시청 부하에서는 **미측정**이다.
  - 힙 상한을 정하지 않으면 JVM은 서버 RAM의 1/4까지 쓴다. `relay.env`의 `JDK_JAVA_OPTIONS`로 정한다: RAM 2 GB면 `-Xmx512m`(예시의 값),
    1 GB면 `-Xmx256m`. MediaMTX와 FFmpeg 몫을 남긴다. 힙 밖 메모리(코드 캐시, 클래스 정보, 스레드)가 더해진다: 위 측정은 힙 상한 256 MB에서
    전체가 최대 303 MB였다.
  - 동시에 흐르는 미디어 응답마다 64 KB(녹화 파일 전송은 256 KB) 버퍼를 쓴다. 상한(`RELAY_MAX_HLS_INFLIGHT` 3000, `RELAY_MAX_DVR_STREAMS` 200)까지
    차면 그것만 약 240 MB이므로, 시청자가 많은 서버는 힙을 그만큼 더 준다.
  - `-XX:+ExitOnOutOfMemoryError`: 메모리가 모자라면 프로세스가 끝나고(종료 코드 3) systemd가 다시 띄운다.
- 서버 측 하위 화질(`RELAY_RENDITIONS`)을 켜면 방송마다 FFmpeg 하나(화질 래더: 원본 디코딩 1회 + 화질마다 libx264 1개)가
  방송 동안(시청자 5분 없으면 멈춤) 돈다. 720p30 화질 하나가 대략 1코어(추정, 서버에서 측정 필요). FFmpeg 경로는 `RELAY_FFMPEG`.
  래더는 **FFmpeg 6.1 이상(libx264 포함)**이 필요하다: 쓰는 옵션 `-enc_time_base:v filter`가 6.1에서 생겼다(FFmpeg 소스로 확인, 낮은
  버전에서의 실행은 미확인. 로컬 검증은 9.0.2). 배포판 패키지가 그보다 낮으면(예: Ubuntu 22.04, Debian 12) `RELAY_RENDITIONS`를 비워 두거나
  FFmpeg를 따로 설치한다.
  래더가 경로를 하나도 내기 전에 끝나면(FFmpeg 없음, 원본을 못 읽음 등) 다시 시작까지 3 s → 6 s → … → 60 s로 늘리고, 그동안
  `live.m3u8`은 `src/`와 서버 화질 없이 원본 경로만 광고한다(시청은 계속됨). 래더 경로가 하나라도 나오면 원래대로 돌아간다.
- 디스크: 녹화(영상 + AAC 128k, Opus는 녹화하지 않음) = 원본 비트레이트 × 보존 시간. 8 Mbps × 6 h ≈ 21.6 GB(로컬 측정: 3 Mbps 약 70초에 28 MB, Opus 녹화 시절 값).
- 소프트웨어: MediaMTX **v1.21.3**(앱과 같은 버전, 릴리스 체크섬 확인), **Java 21 이상 런타임**(헤드리스 JRE면 충분, 로컬 검증은
  21.0.13. 21 미만이면 `UnsupportedClassVersionError`로 시작하지 않는다), Caddy 2, FFmpeg.
  - FFmpeg는 **다시보기(DVR) 녹화에 필요하다**. 녹화 파일은 MediaMTX가 방송마다 띄우는 FFmpeg 복사(`mediamtx-relay.yml`의 `runOnAvailable`)가
    만든다. 예시 설정(`RELAY_DVR=1`)에서 FFmpeg가 없으면 녹화가 생기지 않아 다시보기가 비고, MediaMTX는 그 명령을 계속 다시 시도한다
    (설정의 뜻으로 판단, 미실행). 복사만 하므로 화질 래더의 6.1 조건은 해당하지 않는다(배포판 패키지 버전에서의 실행은 미확인).
    화질 래더와 AAC 변환에도 쓴다(위). `RELAY_DVR=0`으로 다시보기를 끄고 yml의 `runOnAvailable` 두 줄도 지운 경우에만 없어도 된다.
  - Ubuntu 22.04(universe)·24.04, Debian 13: `sudo apt install openjdk-21-jre-headless`. Debian 12는 저장소에 17까지만 있어
    Eclipse Temurin(`temurin-21-jre`, 무료, GPLv2 + Classpath Exception)을 쓴다. 이 패키지는 Debian 저장소가 아니라 Adoptium apt 저장소
    (packages.adoptium.net)에 있으므로 그 저장소를 먼저 추가한다. x86_64·arm64 모두 제공된다(패키지 목록으로 확인, 설치는 미실행).
  - 빌드에는 JDK 21이 필요하지만 서버에는 필요 없다. jar는 빌드 PC에서 만들어 복사한다(서버에서는 빌드하지 않는다. JDK와 Gradle은 서버에 필요 없다).
- 회선: 송신 대역폭이 곧 수용 인원이다. 10장(예산)을 먼저 확인한다. CDN을 앞에 두면 HLS 송신은 CDN이 맡는다(9장).

## 4. 포트와 방화벽

| 포트 | 공개 | 용도 |
|---|---|---|
| TCP 443, 80 | 예 | Caddy: HTTPS 페이지·API·WHEP·HLS·DVR·WSS 채팅, 80은 인증서 발급·리디렉트 |
| TCP 8322 | 예(송출 PC만 쓰면 송출 PC IP로 제한 가능) | RTSPS 송출 입력(TLS + 송출 계정) |
| UDP 8189 | 예 | WebRTC 미디어(기본) |
| TCP 8189 | 예 | WebRTC 미디어 대체(UDP 차단 망) |
| 127.0.0.1: 8080, 8554, 8888, 8889, 9996, 9997, 9998 | **아니오** | 중계 웹 서비스(frame-api), 평문 RTSP(서버 내 인코더), HLS, WHEP HTTP, playback, API, metrics |

클라우드 보안 그룹과 호스트 방화벽(예: `ufw allow 443/tcp`, `80/tcp`, `8322/tcp`, `8189/udp`, `8189/tcp`)을 **둘 다** 연다.
루프백 포트는 열지 않는다. `ss -ltnup`로 9997·9996 등이 127.0.0.1에만 묶였는지 확인한다.

## 5. 설치 절차(예: Ubuntu)

```sh
# 0) 계정과 폴더
sudo useradd --system --home /var/lib/frame-relay --shell /usr/sbin/nologin frame-relay
sudo install -d -o frame-relay -g frame-relay -m 750 /var/lib/frame-relay /var/lib/frame-relay/stats /var/lib/frame-relay/vod
sudo install -d -m 750 -g frame-relay /etc/frame-relay /etc/frame-relay/tls
sudo install -d /opt/frame-relay/ui/assets/fonts /opt/frame-relay/ui/assets/js

# 1) 프로그램: 중계 웹 서비스 jar와 Java 21 런타임, Caddy, FFmpeg, 기존 시청 화면(outputs/index.html + outputs/assets/fonts + outputs/assets/js의 hls.js)
#    아래 명령은 서버의 한 폴더에서 실행한다. 그 폴더에 저장소의 deploy/와 outputs/를 같은 상대 경로로 복사해 둔다
#    (저장소 전체를 복사하거나 clone해도 된다. 소스와 Gradle은 서버에서 쓰지 않는다).
#    jar는 빌드 PC(JDK 21)에서 만든다: cd apps/api && ./gradlew bootJar  →  apps/api/build/libs/frame-api.jar
#    만든 jar를 서버의 그 폴더 아래 같은 경로(apps/api/build/libs/)에 복사해 둔다. build/는 git에 없어서 clone만으로는 생기지 않는다.
sudo apt install openjdk-21-jre-headless            # Debian 12는 Adoptium apt 저장소를 추가한 뒤 temurin-21-jre (3장)
sudo apt install caddy ffmpeg                       # Caddy 2(배포판에 없으면 Caddy 공식 apt 저장소), FFmpeg(다시보기 녹화에 필요, 3장). 설치는 미실행
java -version                                       # 21 이상. /usr/bin/java가 더 낮은 버전을 가리키면 단위 파일의 ExecStart에 21의 경로를 적는다
sudo install -m 644 apps/api/build/libs/frame-api.jar /opt/frame-relay/frame-api.jar
sudo cp outputs/index.html /opt/frame-relay/ui/
sudo cp outputs/assets/fonts/PretendardVariable.woff2 outputs/assets/fonts/OFL.txt /opt/frame-relay/ui/assets/fonts/
sudo cp outputs/assets/js/hls-1.5.20.min.js outputs/assets/js/hls.js-1.5.20-LICENSE.txt /opt/frame-relay/ui/assets/js/   # deps/manifest.json의 SHA-256 확인
# MediaMTX v1.21.3 linux 바이너리를 /usr/local/bin/mediamtx 로(체크섬 확인 후)
sudo cp deploy/mediamtx-relay.yml /etc/frame-relay/

# 2) 비밀: 송출 PC마다 계정 비밀번호(해시만 서버에)와 토큰, 공인 주소. 예: 송출 PC 1 = frame-sender-01 / screen-01
PASS1=$(openssl rand -hex 24)       # 송출 PC 1 설정에 넣을 원문. 안전한 경로로 전달하고 셸 기록에 남기지 않는다.
HASH1=$(printf %s "$PASS1" | openssl dgst -binary -sha256 | openssl base64)
TOKEN1=$(openssl rand -hex 32)      # 송출 PC 1의 등록·썸네일 토큰
echo "$TOKEN1 screen-01" | sudo tee /etc/frame-relay/publisher-tokens >/dev/null   # 송출 PC마다 "<토큰> <경로>" 한 줄(tee -a)
sudo cp deploy/mediamtx.env.example /etc/frame-relay/mediamtx.env   # MTX_AUTHINTERNALUSERS_1_PASS=sha256:$HASH1, 공인 IP 기입. 쓰지 않는 계정 줄은 주석(#)으로 둔다
sudo cp deploy/relay.env.example /etc/frame-relay/relay.env         # RELAY_PUBLIC_BASE_URL 등 기입, JDK_JAVA_OPTIONS의 -Xmx를 서버 RAM에 맞춤(3장)
# 파일에만 640을 준다. "chmod 640 /etc/frame-relay/*"는 tls/ 폴더의 실행(x) 비트까지 지워 frame-relay 계정이
# rtsps.key를 못 읽게 되고 mediamtx-relay가 시작하지 않는다. 폴더는 0)에서 만든 750을 유지한다.
# 파일 이름을 하나씩 적는다. "/etc/frame-relay/*.env" 같은 패턴은 sudo 앞의 셸이 펼치는데, 그 셸은 750 폴더를 읽지 못해 명령이 실패한다.
sudo chown root:frame-relay /etc/frame-relay/mediamtx.env /etc/frame-relay/relay.env /etc/frame-relay/publisher-tokens /etc/frame-relay/mediamtx-relay.yml
sudo chmod 640 /etc/frame-relay/mediamtx.env /etc/frame-relay/relay.env /etc/frame-relay/publisher-tokens /etc/frame-relay/mediamtx-relay.yml

# 3) HTTPS: Caddy
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile   # 도메인 수정
sudo systemctl reload caddy

# 4) RTSPS 인증서: Caddy가 받은 인증서(또는 certbot)를 복사. 갱신 후 다시 복사하고 mediamtx-relay를 재시작한다.
#    Caddy 기본 저장 위치 예: /var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<도메인>/
#    그 폴더는 caddy 계정만 읽을 수 있다. 원본을 전체 경로로 적어 sudo(root)가 읽게 한다(파일 이름만 적으면 찾지 못한다).
CERT_DIR=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<도메인>
sudo install -m 640 -g frame-relay "$CERT_DIR/<도메인>.crt" /etc/frame-relay/tls/rtsps.crt
sudo install -m 640 -g frame-relay "$CERT_DIR/<도메인>.key" /etc/frame-relay/tls/rtsps.key

# 5) 서비스
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx-relay frame-relay
```

설치 확인:

```sh
systemctl status frame-relay                      # active (running)
journalctl -u frame-relay -n 20                   # "FRAME API ...: N publisher token(s); renditions [...]; DVR on; ..." 한 줄과 경고(있으면)
curl -s https://<도메인>/healthz                 # {"ok":true,"backend":"spring","mediamtx":true,...}
curl -s http://127.0.0.1:9997/v3/paths/list       # 서버 안에서만. 송출 후 ready:true
ss -ltnup | grep -E '8189|8322|9997|9996|8080'    # 9997·9996·8080은 127.0.0.1이어야 함
```

`MTX_WEBRTCADDITIONALHOSTS`가 비어 있으면 MediaMTX가 시작하지 않는다(설정 오류로 열린 채 시작하지 않도록 의도한 동작,
로컬에서 확인). `MTX_AUTHINTERNALUSERS_<번호>_PASS`를 빠뜨린(또는 주석으로 둔) 계정은 yml의 자리표시 해시 때문에 송출이 거부된다.
값을 넣을 때는 `sha256:` 뒤가 base64여야 한다. 예시의 `REPLACE_WITH_…` 글자를 그대로 두면 MediaMTX가 시작하지 않는다
(`sha256 hash must be base64 encoded`, 이 PC의 MediaMTX v1.21.3으로 확인).

**새 버전 배포**: 빌드 PC에서 만든 `frame-api.jar`를 서버에 복사한 뒤, 그 폴더에서 교체와 재시작을 이어서 한다.

```sh
sudo cp -p /opt/frame-relay/frame-api.jar /opt/frame-relay/frame-api.jar.prev     # 되돌릴 때 쓸 이전 jar
sudo install -m 644 frame-api.jar /opt/frame-relay/frame-api.jar && sudo systemctl restart frame-relay
```

실행 중인 JVM은 jar에서 클래스를 필요할 때 읽는다. jar만 바꿔 놓고 재시작을 미루면 그 사이 처음 쓰이는 클래스를 읽다가 오류가 날 수
있으므로(JVM과 Spring Boot의 일반 동작, 미실행) 교체 직후에 재시작한다. 되돌릴 때는 `.prev`를 같은 `install` 명령으로 다시 넣고 재시작한다.
재시작 동안의 동작은 8장을 본다.

**송출 PC 추가**: `mediamtx-relay.yml`의 `authInternalUsers`에 `frame-sender-03`(경로 `screen-03`) 항목을 같은 형식으로
추가하고, `mediamtx.env`에 `MTX_AUTHINTERNALUSERS_3_PASS`, 토큰 파일에 `<토큰> screen-03`을 넣은 뒤 두 서비스를 재시작한다.
계정은 자기 경로(와 그 PC가 직접 올리는 `<경로>/<화질>`)에만 송출할 수 있고, 토큰은 자기 경로만 등록·종료·썸네일할 수
있다. 그래서 다른 송출 PC의 비밀번호·토큰으로는 남의 경로를 쓸 수 없고, 원래 송출 PC가 재연결하는 사이에도 가로챌 수 없다
(e2e에서 송출·등록 모두 거부 확인).

## 6. 송출 PC(Windows 앱) 연동 — 앱 담당자 통합 항목

이 저장소 작업에서 앱(native/·work/)은 수정하지 않았다. 앱에 필요한 것:

1. **설정 분리(NET-01, OPS-03)**: 로컬 송출 주소(기존), 중계 서버 공개 주소(`https://relay.example.com`), 중계 송출 입력
   (`rtsps://relay.example.com:8322/<path>`), **그 송출 PC의** 계정 이름(`frame-sender-NN`)·비밀번호, 송출 토큰을 각각 둔다.
   `<path>`는 그 계정·토큰에 배정된 경로(`screen-NN`)와 같아야 하고, 등록하는 `item.path`도 같은 값이어야 한다(다르면 송출은
   거부되거나 목록에 안 나온다). 비밀번호·토큰은 UI 표시·로그·생성 yml에 남기지 않는다.
2. **원본 전달(NET-02)**: e2e는 앱 방식 그대로 검증한다. 방송 경로가 로컬 MediaMTX에서 준비되면 앱이 자기 FFmpeg 하나를
   띄워 복사(재인코딩 없음)로 중계 서버에 올리고, 끝나면(중계 재시작·회선 끊김) 2·4·8·16·30초 간격(30초 넘게 유지되면 처음부터)으로 다시 띄운다(e2e는 더 짧은 간격으로 같은 동작을 흉내 낸다):
   ```
   ffmpeg -hide_banner -nostdin -loglevel warning -rtsp_transport tcp -i rtsp://127.0.0.1:<로컬포트>/<path>
          -map 0 -c copy -f rtsp -rtsp_transport tcp -pkt_size 1190 [-ca_file <자체서명 인증서>]
          rtsps://frame-sender-NN:<비밀번호>@relay.example.com:8322/<path>
   ```
   - `-pkt_size 1190`: 중계 yml의 `udpMaxPayloadSize: 1200`에 맞춤(재패킷화 경고가 사라짐을 e2e로 확인).
   - FFmpeg 9는 RTSPS 인증서를 기본 검증한다. 공인 인증서면 그대로, 자체 서명이면 `-ca_file`. 비밀번호의 `@ : /` 등은 URL 인코딩.
   - 비밀번호가 송출 PC의 프로세스 명령줄에 보인다(같은 PC의 다른 프로세스가 읽을 수 있음). 저장되는 로그에는 남기지 않는다.
   - 대안: 로컬 MediaMTX `forward`(`PATCH /v3/config/paths/patch/<path>` `{"forward":[{"dest":"rtsps://..."}]}`). 파일에는
     안 남지만 로컬 API `GET /v3/config/paths/get/<path>`가 비밀번호가 든 주소를 그대로 돌려준다(루프백 무인증).
   - **송출 PC MediaMTX의 `writeQueueSize`를 4096으로** 올린다(앱이 생성하는 mediamtx.yml). 기본 512 패킷은 3 Mbps에서 약
     1.6초라, 업로드가 1~2초만 막혀도 MediaMTX가 `write queue is full`로 중계 전송을 끊는다(점검 실행에서 실제 발생).
     4096이면 같은 조건에서 약 13초를 버틴다(계산, 실제 회선 미측정. 메모리는 전송마다 최대 약 5 MB). e2e의 송출 측 설정이 이 값이다.
3. **방송 등록(NET-06), 계약 v1**: 2초마다 `POST https://relay.example.com/api/broadcasts/announce`,
   `Authorization: Bearer <토큰>`, 본문(4 KB 이하):
   ```
   {"v":1,"type":"announce","item":{"id":"<32 hex>","title":"...","publisher":"...","path":"screen-01","width":1920,"height":1080,
    "fps":60,"startedAtMs":<송출 PC 시각>,"bitrate":8,"audio":"system","renditions":[{"name":"720p","width":1280,"height":720,
    "mbps":3.5,"fps":60,"codec":"H.264"}],"sentAtMs":<보낸 순간의 송출 PC 시각>}}
   ```
   - `host`/`port`는 무시하고 중계 서버 자기 공개 주소를 `baseUrl`로 쓴다. 발신 IP 검사는 하지 않는다(NAT 때문, 대신 토큰).
   - `sentAtMs`: 첫 등록에서 송출 PC와 서버의 시계 차이를 재서 `startedAtMs`·경과 시간·DVR 시작을 서버 시계로 맞춘다
     (e2e: 60초 앞선 송출 PC 시계를 보정). 없으면 송출 PC 시계를 그대로 믿는다.
   - `bitrate`(Mbps)·`audio`(`none|system|mic|mix`)가 없으면 중계가 측정한 수신량, Opus 트랙 유무로 채운다.
     `renditions`는 송출 PC가 직접 `<path>/<화질>`로 올리는 화질만(그 경로를 RTSPS로 받는 동안만 광고). 잘못된 선택 필드는
     등록을 거부하지 않고 버리며 `X-Frame-Ignored: audio`처럼 알려 준다.
   - 응답 204 + `X-Frame-Media-Ready: 1|0`. 0이면 "등록은 됐지만 영상이 중계 서버에 도착하지 않음"(목록에 안 보임).
     401 토큰 오류, 403 그 토큰에 배정되지 않은 경로 또는 다른 토큰의 방송, 409 같은 경로를 다른 방송이 사용 중,
     429 과다 요청, 503 목록 가득 참(모두 `Retry-After` 포함).
   - 종료 시 `{"v":1,"type":"bye","id":"<id>"}`(즉시 목록에서 빠짐). bye 없이 끊기면 마지막 등록 15초 뒤 만료되고, 그 경로는
     `RELAY_MEDIA_GRACE_MS` 동안 같은 토큰에게만 예약된다.
4. **썸네일(NET-07)**: `PUT https://relay.example.com/api/broadcasts/<id>/thumbnail`, `Authorization: Bearer <토큰>`,
   `Content-Type: image/jpeg`, 256 KB 이하. 시청자는 `/thumbnails/<id>.jpg`(4초 캐시).
5. **채팅**: 인터넷 시청자 채팅방은 중계 서버(`wss://.../<path>/chat`)에 있다. 송출 PC 화면의 채팅 패널이 지금처럼
   `127.0.0.1` 내부 채팅에 붙으면 인터넷 시청자와 다른 방이 된다. 인터넷 송출 중에는 앱의 송출자 채팅도 중계 서버 채팅에
   붙이는 것이 맞다(앱·UI 담당 결정 필요). 같은 IP는 같은 이름을 함께 쓸 수 있다(기존 "같은 PC" 규칙의 대체).
6. **시청 화면(UI)이 쓰는 것**:
   - `/<path>/info`: `running`, `mediaReady`, `renditions`(각 `{name,width,height,mbps,fps,codec}`; 서버 측 인코더는
     `scale=-2:H` 결과 그대로라 1280×720의 480p는 854×480), `hls`(`{"master":"live.m3u8","lowLatency":true,"audio":"aac"|"none",
     "dvr":"dvr.m3u8"|null,"scope":"b/<id>/"}`, `<origin>/<path>/` 기준 — `scope` 말고는 앱 시청 서버와 같은 값), `hlsVariants`(MediaMTX
     자체 재생 목록, 이전 페이지용).
   - **HLS 음성**: 송출이 둘째 음성으로 AAC를 올리면(지금 앱) 그 트랙을 그대로 쓴다(`hls/audio3_stream.m3u8`, 하위 화질도 복사).
     AAC 없이 Opus만 올리는 송출(이전 버전 앱)은 `RELAY_HLS_AAC=1`일 때 서버의 AAC 변환 경로(`aac/hls/...`, 영상 복사·음성만
     변환)를 원본 화질 하나로만 광고한다(하위 화질은 송출의 음성을 복사하므로 AAC가 없다). 둘 다 아니면 `audio:"none"`(영상만).
     이전 버전 앱의 녹화(DVR)는 영상만 남는다(녹화 복사는 둘째 음성만 옮김).
   - `GET /<path>/live.m3u8[?q=<화질>|source]`: 원본 다음 하위 화질(높은 순). 화질마다 `EXT-X-MEDIA`(AAC 그룹)와
     `EXT-X-STREAM-INF`(`BANDWIDTH`=설정 비트레이트+128k, `AVERAGE-BANDWIDTH`=그 경로의 실측 평균, `CODECS`=MediaMTX가 읽은
     실제 SPS 또는 해상도·fps로 계산한 High 레벨). `?q=`는 그 화질 하나만(Safari 기본 플레이어의 수동 선택).
   - `GET /<path>[/<화질>]/hls/<파일>`: MediaMTX LL-HLS 재생 목록·init·part·세그먼트. relay가 경로·화질마다 MediaMTX 세션 하나를
     만들어 모든 시청자가 함께 쓰고(쿠키 확인도 relay가 처리, `index.m3u8` 없이 `video1_stream.m3u8`을 바로 받아도 됨) 재생 목록의
     세션 값을 지운다. 같은 블로킹 요청(`_HLS_msn`/`_HLS_part`)은 MediaMTX에 한 번만 묻는다.
   - `GET /<path>/dvr.m3u8`, `/<path>/dvr/file.mp4?id=<방송>&f=<파일>[&s=<세그먼트>]`: 이 방송 녹화의 HLS(EVENT). `f`는 목록 안
     순서가 아니라 그 녹화 파일의 시작 시각(파일 이름의 시각, epoch ms)이라 relay 재시작·보존 삭제 뒤에도 같은 URL은 같은 바이트다. 파일마다
     `EXT-X-MAP`(그 파일의 ftyp+moov 바이트 범위)과 키프레임에서 자른 약 4초 세그먼트(녹화 part의 샘플을 바이트 그대로 옮긴
     moof+mdat, 재인코딩 없음), 파일 사이 `EXT-X-DISCONTINUITY`, `EXT-X-PROGRAM-DATE-TIME`. `s` 없이는 파일 자체를 Range로(목록에
     오른 바이트까지만, 206/416). 다른 방송 id 409, 없는 파일·세그먼트 404, 잘못된 값 400. 보존 기간(6 h)이 지나 지워진 파일은
     목록에서 빠지고 `MEDIA-SEQUENCE`/`DISCONTINUITY-SEQUENCE`가 그만큼 늘어난다(그때부터 EVENT 표시 없음). 기존
     `/<path>/dvr`(JSON)·`/<path>/dvr/media`(MSE 조각, 이제 H.264 + AAC)도 그대로 있다. 녹화는 `<녹화 폴더>/<path>/rec/`.
   - **방송 단위 주소 `/<path>/b/<방송 id>/`**(새 공유 링크, React 시청 화면): 위 라우트를 방송 하나에 묶은 것이다. `/info`의
     `hls.scope`(`"b/<id>/"`, `/<path>/` 기준)로 알린다. 받는 라우트는 `live.m3u8[?q=]`, `[<화질>/|src/|aac/]hls/<파일>`(GET·HEAD),
     `dvr`, `dvr.m3u8`, `dvr/file[.mp4]?id=&f=[&s=]`, `session`(POST), `session/<sid>`(PUT·DELETE)뿐이고 나머지는 404다.
     - 응답 본문과 캐시 헤더는 `/<path>/...`와 같다. 재생 목록의 URI가 상대 경로라 하위 목록·init·part·세그먼트·녹화 파일이 모두
       접두사 아래로 풀리고, 캐시 키(브라우저·CDN)에 방송 id가 들어간다.
     - 모든 요청이 먼저 그 경로의 현재 방송을 확인한다. 방송이 없으면 `404 {"error":"not-running"}`, 다른 방송이면
       `409 {"error":"broadcast-changed"}`(둘 다 `no-store`). 같은 경로에서 다음 방송이 시작돼도 이전 링크는 새 방송의 영상·녹화·
       세션을 받지 못한다. 기다림(화질 인코더 기동, 블로킹 재요청, 녹화 검사) 뒤에 응답하기 전에도 다시 확인한다.
     - `live.m3u8`·`hls/*`: 다음 송출 세션은 이 방송의 영상으로 보지 않고 `503 + Retry-After: 2`(`Media is not ready yet`)로 답한다.
       - 방송 시작보다 10 s 넘게 먼저 시작된 세션(이전 방송의 송출이 아직 남음). 화질 경로도 같다.
       - 이 방송의 마지막 등록보다 나중에 시작된 세션. 송출은 2 s마다 등록하므로 방송 시작·재연결 뒤 다음 등록(2 s 이하)까지
         기다린다. 이전 방송의 `bye`가 유실된 채 다음 방송의 송출이 그 방송의 첫 등록보다 먼저 도착해도, 이전 링크는 그 영상을
         받지 않고 기다리다가 다음 방송이 등록되면 409를 받는다(설계 5.3: 등록과 미디어 준비 순서가 바뀌는 경우). 블로킹 재요청·
         상위 응답을 기다린 뒤에도 마지막 경로 목록으로 다시 확인한다.
       - `/info`는 이 판단과 무관하게 `mediaReady:true`일 수 있다. 영상이 잠깐 끊긴 동안은 기존과 같이 `503 + Retry-After`.
     - 등록은 남아 있지만 유예가 끝난 방송도 접두사 아래에서는 모든 라우트가 `404 {"error":"not-running"}`(JSON)이다. 텍스트 404
       (`Not found`, `Quality is not available`)는 그 화질이 없다는 뜻이고(방송 종료 아님), `No recording`은 DVR이 꺼져 있다는 뜻이다.
     - `dvr`·`dvr.m3u8`·`dvr/file`: 영상이 잠깐 끊긴 동안에도 녹화를 준다(기존과 같음). `dvr/file`의 `id`가 접두사의 방송과 다르면 409.
       위의 다른 송출 세션이 경로에 있는 동안에는 그 세션이 썼을 수 있는 녹화 파일(그 세션 시작 2 s 전 이후에 시작된 파일)을
       목록에 올리거나 내주지 않는다. `dvr`는 503, `dvr.m3u8`는 그런 파일이 목록에 오를 때 503, `dvr/file`은 그런 파일이면 503이다.
     - `session`: POST는 방송 확인 뒤 기존 규칙(상한 `503 + Retry-After: 15`, 과다 429, 유예가 끝난 방송 404)이며 영상 준비 여부로는
       거절하지 않는다. PUT은 방송이 바뀌었거나 없으면 409/404로 답하고 그 세션을 닫는다(새 방송의 시청자로 세지 않음). DELETE는 언제나 처리한다.
     - `/info`, WHEP(`/<path>[/<화질>]/whep`), 채팅(`/<path>/chat`, `join`의 `broadcastId`로 방을 확인), `/<path>/stats`는 경로 주소
       그대로다. 기존 `/<path>/...` 주소는 그 경로의 현재 방송을 준다(기존 페이지·링크용).
     - WHEP POST에 `?b=<방송 id>`(32자리 16진수, React 시청 화면의 WebRTC 대체 경로)를 붙이면 위 접두사와 같은 규칙으로 묶는다.
       방송이 없으면 404 `not-running`, 다른 방송이면 409 `broadcast-changed`, 이 방송의 송출 세션이 아니면 `503 + Retry-After: 2`이고,
       형식이 틀린 id는 400이다. 이 확인은 시청자 상한·요청 제한보다 먼저 한다. 클라이언트는 연결 전후로 `/info`의 `broadcastId`도 확인한다.
     - 남은 틈: 두 송출이 같은 경로를 동시에 쓰면서 둘 다 계속 등록하면(같은 토큰·경로의 잘못된 설정) 등록만으로는 송출 세션의
       주인을 알 수 없다. 송출 세션 자체를 방송 id에 묶으려면 송출 주소에 방송 id를 넣는 앱·MediaMTX 쪽 변경이 필요하다(후속).
       경로 목록은 1 s 캐시라, 새 세션이 시작된 직후 1 s 안의 응답은 이전 세션 기준으로 판단될 수 있다(새 먹서는 그보다 늦게
       첫 재생 목록을 낸다).
   - **시청 세션**: `POST /<path>/session` → `200 {"sid","heartbeatMs":15000}`, 상한이면 `503 + Retry-After: 15`(같은 주소의 활성
     세션이 `RELAY_MAX_SESSIONS_PER_IP`를 넘어도 503), 방송 없음 404, 과다 요청 429. `PUT /<path>/session/<sid>` 하트비트(204,
     만료·모름 404 → 새로 POST), `DELETE` 떠날 때. 마지막 하트비트가 `RELAY_SESSION_ACTIVE_MS`(30 s) 안이면 활성.
   - `GET [/<path>]/assets/js/<파일>`: `RELAY_JS_DIR`(기본 화면 파일 옆 `assets/js`)의 hls.js. `public, max-age=31536000, immutable`
     (파일 이름에 버전이 있음).
   - 영상만 잠깐 끊기면(송출 PC 재연결, 중계 MediaMTX 재시작) `/info`는 등록이 살아 있는 동안 `RELAY_MEDIA_GRACE_MS`(15초)까지
     `{"running":true,"mediaReady":false}` + `Retry-After: 2`, WHEP·HLS는 `503 + Retry-After`를 준다. UI는 이때 "송출 종료"로
     끝내지 말고 기다렸다 다시 연결해야 한다. 지금 UI는 첫 연결(`connect()`)만 `Retry-After`를 따르고(최대 4회), 재연결
     (`lost()`)은 `Retry-After`를 무시하고 3회 뒤 재생을 끝낸다 — `mediaReady:false`를 대기로 처리하도록 UI 수정이 필요하다.
   - 상한: 시청자 수 = WebRTC 세션 + 활성 시청 세션 + (대체 집계) 세션 없이 최근 `RELAY_HLS_ACTIVE_MS` 안에 HLS를 받은 주소+브라우저
     (세션을 가진 페이지 자신은 두 번 세지 않음). 시청자 상한은 새 세션·새 WHEP에만 `503 + Retry-After`로 적용하고 HLS 미디어
     요청은 거절하지 않는다(모든 시청자·CDN이 같은 응답을 받도록). 소켓 수·채팅 수 초과도 `503 + Retry-After`.
   - **재생 통계**: `POST /<path>/stats`, `Content-Type: text/plain`(sendBeacon) 또는 `application/json`, 2 KB 이하, 페이지(`sid`)당
     4초에 1회(초과 429). 필드: `sid`(필수, 페이지가 만든 무작위 값), `broadcast`, `transport`, `mode`, `quality`, `height`, `fps`,
     `lossPct`, `jitterMs`, `freezes`, `mbps`, `abrSwitches`, `lastSwitch`, `event`, `device`. 서버는
     `RELAY_STATS_DIR/stats-YYYY-MM-DD.csv`(UTC 하루 하나, 열: `time,path,session,broadcast,transport,mode,quality,height,fps,
     loss_pct,jitter_ms,freezes,mbps,abr_switches,last_switch,event,device`)에 추가한다. **IP·브라우저 정보는 저장하지 않는다.**
     하루 파일 50 MB(`RELAY_STATS_MAX_MB`)를 넘으면 그날 나머지는 버린다. 수식으로 시작하는 문자열은 `'`를 붙여 저장한다.

## 7. STUN/TURN

- 중계 서버가 공인 IP를 가지므로 시청자 쪽 NAT 종류와 상관없이 대부분 **TURN 없이** 연결된다(브라우저가 서버 공인 IP:8189로
  나가기만 하면 됨). 서버 쪽 STUN도 필요 없다(공인 주소를 `MTX_WEBRTCADDITIONALHOSTS`로 직접 광고).
- TURN이 필요한 경우: UDP와 8189/TCP가 모두 막히고 443만 허용되는 회사·학교·공공 Wi-Fi. 이때는 **TLS 443 TURN(turns:)**이
  필요하다. Caddy가 이미 443을 쓰므로 TURN은 다른 IP(또는 별도 서버)에 둔다. TURN 서버는 미디어를 한 번 더 중계하므로
  그 시청자 몫의 송신량이 TURN 쪽에도 생긴다(예산에 포함).
- 자격 증명: 고정 비밀번호를 UI에 넣지 않는다. coturn의 `use-auth-secret` + `static-auth-secret`과 같은 비밀을
  `RELAY_TURN_SECRET`에 넣으면 중계 웹 서비스가 `/info` 요청마다 `만료시각:frame` 사용자와 HMAC 자격 증명을 만든다
  (`RELAY_TURN_TTL_S`, 기본 3600초). UI는 연결·재연결 때마다 `/info`를 다시 받으므로 새 자격 증명을 쓴다.
  장시간 시청 중 TURN 할당 갱신이 만료 이후에도 허용되는지는 TURN 서버 구현에 따라 다르다 — **실제 TURN으로 미검증**.
  시청 시간이 긴 방송이면 TTL을 예상 최대 시청 시간보다 길게(예: 43200) 두고, 유출 시 영향(그 시간 동안 TURN 사용 가능)을 감수한다.
- 확인 방법: 시청 PC에서 `edge://webrtc-internals`(Chrome은 `chrome://webrtc-internals`)의 선택된 candidate pair가
  `host`(서버 공인 IP)·`udp`인지, `tcp`인지, `relay`(TURN)인지 본다. 페이지는 열리는데 영상만 안 나오면 미디어 경로(8189) 문제다.

## 8. 재시작·진단

| 증상 | 확인 |
|---|---|
| 페이지 안 열림 | `systemctl status caddy frame-relay`, DNS, 443 방화벽, `journalctl -u caddy` |
| `frame-relay`가 시작하지 않음 | `journalctl -u frame-relay -n 50`. `java`가 없거나 21 미만(`UnsupportedClassVersionError`), 설정값이 범위 밖이거나 형식이 틀림(범위 오류와 `RELAY_RATE_*`·`RELAY_ICE_SERVERS` 형식 오류는 그 `RELAY_*` 이름이, 숫자·스위치 형식 오류는 설정 이름 `frame.…`과 값이 로그에 나온다. `deploy-check.mjs` 4a~4c), 토큰 파일이 없거나 `frame-relay` 계정이 못 읽음, 8080 사용 중. 시작 로그의 "set but not read" 경고는 `relay.env`의 변수 이름 오타다 |
| `frame-relay`가 반복해서 다시 뜸 | `journalctl -u frame-relay`의 `OutOfMemoryError`(종료 코드 3): `JDK_JAVA_OPTIONS`의 `-Xmx`를 올린다(3장). 그 밖의 JVM 오류 기록(`hs_err`)은 서비스 전용 `/tmp`에 남고 서비스가 멈추면 지워지므로 저널의 요약을 본다 |
| `/healthz` 503 | MediaMTX API 응답 없음: `systemctl status mediamtx-relay`, `journalctl -u mediamtx-relay -n 100` |
| 목록이 비어 있음 | 송출 PC의 등록 응답(401/403/409/429), `X-Frame-Media-Ready: 0`이면 RTSPS 송출 실패: `journalctl -u mediamtx-relay | grep -i -E 'authenticat|RTSPS'` |
| 송출 거부 | `failed to authenticate`(비밀번호, 또는 그 계정에 배정되지 않은 경로), `someone is already publishing`(같은 경로 사용 중), 인증서 검증 실패(송출 PC 쪽 로그) |
| 영상만 안 나옴 | UDP/TCP 8189 방화벽, `MTX_WEBRTCADDITIONALHOSTS`가 실제 공인 IP인지, webrtc-internals의 candidate |
| 채팅 끊김 | Caddy 로그의 101 응답, relay 로그 `chat connection limit`, 프록시 유휴 시간(서버가 25초마다 ping) |
| DVR 없음 | `RELAY_DVR`, `RELAY_RECORD_DIR`, 녹화 폴더 쓰기 권한·디스크 여유, `curl http://127.0.0.1:9996/list?path=<path>/rec`, MediaMTX 로그의 `runOnAvailable` 복사 FFmpeg |
| HLS가 안 나옴(`/info`는 정상) | `curl -s https://<도메인>/<path>/live.m3u8`, `.../hls/video1_stream.m3u8`(502면 relay 로그 `HLS session for`), 음성이 없으면 송출이 AAC를 올리는지(`/v3/paths/get/<path>`의 tracks) |
| 목록이 잠깐 비거나 `/healthz`의 `mediamtxListStale:true` | MediaMTX API가 느림·실패: 마지막 정상 목록을 `RELAY_MEDIAMTX_STALE_MS`(15초) 동안 유지하고 그 뒤 비운다 |
| 재생 통계가 안 쌓임 | `RELAY_STATS_DIR` 설정·쓰기 권한(systemd `ReadWritePaths`), 로그 `playback stats`, 하루 50 MB 상한 |

- 재시작: `sudo systemctl restart mediamtx-relay`(송출 PC의 전달 FFmpeg가 다시 떠서 재연결. 그동안 시청자는 "송출 종료"가 아니라
  `mediaReady:false`로 대기),
  `sudo systemctl restart frame-relay`(목록은 다음 등록(2초 이내)에 복구, 채팅방 기록은 메모리라 초기화됨). 아래는 재시작 동안의 동작이다.
  - 멈출 때: 채팅 참가자에게 "서버가 떠남"(1001)으로 닫는다고 알리고, 진행 중인 요청을 최대 2초 기다린 뒤 끝난다. 화질 래더 FFmpeg도
    함께 끝난다(2초 안에 끝나지 않으면 강제 종료). 요청 하나가 MediaMTX에 잡혀 있는 경우 4.3 s(`apps/api`의 `ShutdownTest`로 측정).
    종료 코드 143은 정상이다.
  - 다시 뜰 때: JVM 기동에 이 PC에서 2.1 s(`deploy-check.mjs`), 끄고 다시 띄워 `/healthz`가 답할 때까지 6.4 s였다(같은 날 앞선 실행은 3.1 s. 실행마다 다르다). 그동안 Caddy는
    502로 답한다(로컬 Caddy 측정 5.7 s). 작은 VM에서는 더 걸린다(**서버 미측정**).
  - 시작 유예: 시작 뒤 5초 동안은 목록이 아직 비어 있으므로, 방송이 없는 경로의 시청 요청에 "방송 없음" 대신
    `503 + Retry-After: 2`로 답한다. 재생 중이던 React 시청 화면은 "방송에 다시 연결하는 중이에요", "방송 신호를 기다리고 있어요" 문구를 보였다가 새로 고침 없이 이어서
    재생하고 채팅도 다시 붙는다(로컬 Caddy 1회 측정: 끈 뒤 16.3 s에 다시 재생, 목록은 8.1 s에 복구. `https-check.mjs` H10).
    이전 Node 중계는 재시작 직후 "방송 없음"으로 답해서, 열려 있던 화면이 "방송이 종료됐어요"로 끝났다(같은 검사, ready → ended).
  - 기존 단일 파일 화면(`/<path>`)은 재연결을 3회까지만 한다(6장의 UI 한계). 이번 측정에서는 스스로 다시 재생했다. 안 돌아오면 새로 고친다.
  - 그래도 몇 초의 끊김은 생긴다. 가능하면 방송이 없을 때 재시작한다.
- **Java 런타임 패키지를 올린 뒤에는 `frame-relay`를 재시작한다**(자동 보안 업데이트 포함). 실행 중인 JVM은 바뀐 런타임의 보조 실행 파일
  (`jspawnhelper`)과 버전이 맞지 않으면 새 프로세스를 띄우지 못해 화질 래더(FFmpeg)가 시작되지 않는다(JDK 소스로 확인, 미실행).
- 로그에는 토큰·비밀번호·채팅 본문·SDP를 쓰지 않는다. 거부 사유는 같은 IP·사유당 1분에 1줄.
- MediaMTX 지표: 서버 안에서 `curl http://127.0.0.1:9998/metrics`(경로별 송수신 바이트, 세션 수).

## 9. HLS 캐시·CDN 규칙

relay의 HLS 응답은 시청자와 무관하게 같은 바이트이고 `Set-Cookie`가 없다(MediaMTX 세션·쿠키 확인은 relay 안에서 끝남).
그래서 CDN·캐시 프록시를 relay(또는 Caddy) 앞에 둘 수 있다. **CDN은 이 저장소에서 실행·검증하지 않았다**(무료 CDN의 영상
전송 허용 여부도 약관으로 먼저 확인). 아래는 relay가 보내는 헤더와 CDN에 넣을 규칙이다.

| 경로 | relay의 `Cache-Control` | CDN 캐시 키 | 비고 |
|---|---|---|---|
| `/<path>/live.m3u8` | `max-age=2` | 경로 + `q` | 화질 목록. 시청자별 값 없음 |
| `/<path>[/<화질>]/hls/*.m3u8` | `max-age=1` | 경로 + `_HLS_msn`, `_HLS_part`, `_HLS_skip` | LL-HLS 블로킹 요청: 다음 part가 생길 때까지 응답이 늦게 온다. CDN은 같은 키의 요청을 하나로 묶고(request collapsing) 원본 응답 대기를 15 s 이상 허용해야 한다. 이 세 키 말고는 무시한다 |
| `/<path>[/<화질>]/hls/*.mp4`, `*.m4s` (init, part, 세그먼트) | `public, max-age=60` | 경로만 | 이름이 MediaMTX 먹서마다 고유. 미리 알린 part(`EXT-X-PRELOAD-HINT`)는 만들어지는 동안 스트리밍되므로 CDN이 버퍼링 없이 흘려야 한다 |
| `/<path>/dvr.m3u8` | `no-cache` | 경로 | 매번 재검증(새 세그먼트가 붙음) |
| `/<path>/dvr/file.mp4?id=&f=&s=` | 세그먼트·끝난 파일 `public, max-age=3600`, 쓰는 중인 파일 `no-cache` | 경로 + `id`, `f`, `s` (+ `Range`) | `Range` 요청(206)을 그대로 넘기거나 범위 캐시를 지원해야 한다 |
| `/<path>/b/<id>/live.m3u8`, `.../hls/*`, `.../dvr.m3u8`, `.../dvr/file.mp4` (방송 단위 주소) | 위 같은 이름의 경로와 같음. 거절(404·409)은 `no-store` | 위와 같음(경로에 방송 id가 들어감) | 방송이 바뀌면 이전 접두사는 409라, 캐시에 남은 이전 방송의 응답이 새 방송 링크에 섞이지 않는다 |
| `[/<path>]/assets/js/*.js`, `/assets/fonts/*` | `public, max-age=31536000, immutable` / `max-age=86400` | 경로 | |
| `/`, `/<path>`(화면), `/<path>/info`, `/api/*`, `/<path>[/b/<id>]/dvr`, `/<path>/dvr/media`, `/<path>[/b/<id>]/session*`, `/<path>/stats`, `/<path>/whep*`, `/<path>/chat`(WebSocket), `/healthz`, `/thumbnails/*` | `no-store`(썸네일 `max-age=4`) | 캐시 안 함 | 시청자별(TURN 자격 증명, 세션 id, SDP) 또는 실시간 상태. 그대로 relay로 보낸다 |

- **절대 캐시하지 않는다**: `Set-Cookie`가 있는 응답, `Authorization`이 붙은 요청(송출 등록·썸네일), `no-store` 응답, 4xx/5xx
  (relay의 404·502·503은 `no-store`이고 503에는 `Retry-After`가 있다). CDN이 쿠키를 붙이거나 캐시 키에 쿠키·`User-Agent`를 넣지 않게 한다.
- 위 표 밖의 쿼리(추적 파라미터 등)는 캐시 키에서 뺀다. `live.m3u8`의 `q`, LL-HLS의 `_HLS_*`, DVR의 `id`·`f`·`s`만 남긴다.
- CDN이 LL-HLS 블로킹을 지원하지 않으면 플레이어는 1 s 세그먼트 단위로 받는다(지연이 몇 초 늘 뿐 재생은 됨).
- **시청자 수와 CDN**: CDN 뒤의 relay는 캐시 미스만 보므로 HLS 미디어 요청으로 시청자를 셀 수 없다. 시청자 수와 상한은 시청
  세션(`POST /<path>/session`, 15 s 하트비트, 캐시하지 않음)으로만 센다: `RELAY_HLS_COUNT_WITHOUT_SESSION=0`으로 대체 집계를 끈다
  (켜 두면 CDN 노드 주소가 시청자로 잡힌다). 세션 요청에는 CDN이 원래 시청자 주소를 `X-Forwarded-For`로 넘기고 그 CDN 주소를
  `RELAY_TRUSTED_PROXIES`에 넣어야 주소별 제한(`RELAY_MAX_SESSIONS_PER_IP`, `RELAY_RATE_SESSION`)이 시청자별로 동작한다.
  세션을 열지 않는 플레이어(직접 만든 클라이언트)는 CDN 뒤에서 세어지지 않고 상한에도 걸리지 않는다.
- CDN 없이(relay 직접)도 같은 헤더로 브라우저 캐시가 동작한다. relay의 같은 재생 목록 요청 묶기(1 s)는 CDN 유무와 상관없다.

## 10. 무료 자원·트래픽 예산 (NET-10)

**어떤 무료 서버도 1,000명을 받는다고 가정하지 않는다.** 송신량은 시청자 수 × 비트레이트다.

| 화질(서버 송신 비트레이트) | 시청자 1명/시간 | 100명/시간 | 1,000명 동시 대역폭 | 1,000명/시간 |
|---|---|---|---|---|
| 1080p 8 Mbps | 3.6 GB | 360 GB | 8 Gbps | 약 3.6 TB |
| 720p 3.5 Mbps | 1.58 GB | 158 GB | 3.5 Gbps | 약 1.6 TB |
| 480p 1.8 Mbps | 0.81 GB | 81 GB | 1.8 Gbps | 약 0.8 TB |
| 360p 0.9 Mbps | 0.41 GB | 41 GB | 0.9 Gbps | 약 0.4 TB |

(영상 데이터만. RTP/SRTP/UDP/IP 오버헤드 수 %, TURN 중계분, 엣지 노드 간 전송, 녹화 디스크 쓰기는 별도)

무료 호스트를 쓰기 전에 **반드시 확인**할 것(계정의 실제 약관·대시보드 값으로):

1. 월 송신(egress) 무료 한도와 초과 시 동작(과금 / 속도 제한 / 정지). 예: 월 10 TB가 무료라고 해도 8 Mbps × 1,000명은
   약 2.8시간에 소진된다(가정 계산).
2. 인스턴스 네트워크 대역폭 상한(예: 수십 Mbps~1 Gbps). 동시 수용 상한 ≈ 상한 × 0.7 ÷ 비트레이트
   (1 Gbps, 8 Mbps → 약 87명; 100 Mbps → 약 8명).
3. 영상 스트리밍·프록시·중계 용도가 약관상 허용되는지, UDP 수신과 임의 포트(8189, 8322) 개방이 가능한지, 공인 IPv4 제공 여부.
4. CPU 크레딧·버스트 제한(화질 인코더를 켜면 지속 CPU 사용), 디스크 용량(녹화 보존).
5. 결제 수단 등록 시 자동 유료 전환 여부. **유료 자원 생성·자동 업그레이드·유료 트래픽 사용 금지.**

시험 운영 규칙(중단 조건):

- `RELAY_MAX_VIEWERS_PER_PATH`를 위 2번의 동시 수용 상한 이하로 둔다(초과 시청자는 503 + Retry-After로 대기).
- 시험마다 최대 시간과 최대 송신량을 먼저 정한다(예: 30분, 100 GB). 측정: `vnstat`/`ip -s link` 또는
  MediaMTX metrics의 송신 바이트.
- 다음 중 하나면 즉시 중단: 월 한도의 80% 도달, 호스트의 속도 제한·경고 메일, 서버 CPU 85% 이상 5분 지속,
  패킷 손실 증가로 재버퍼 비율 1% 초과, 디스크 90% 이상.
- 작은 인원 결과를 1,000명으로 선형 외삽하지 않는다. 지원 환경이 없으면 해당 단계는 미검증으로 남긴다.

## 11. 로컬 재현 검증

```sh
export JDK_JAVA_OPTIONS="-Xmx256m -XX:+ExitOnOutOfMemoryError"   # 아래 "힙 256 MB" 결과는 이 값으로 실행했다(스크립트는 -Xms64m만 준다)
node server/verify/e2e.mjs --backend spring   # 배포하는 백엔드(frame-api.jar). 먼저 (cd apps/api && ./gradlew test bootJar), JAVA_HOME = JDK 21.
                                              # 약 2~3분(헤드리스 Edge 포함). 포트 24000-24999만 사용. 결과: verification/spring/relay/
node server/verify/e2e.mjs                    # 비교 기준(이전 Node 중계). 결과: deploy/verification/e2e-result.json, *.png, logs/
node server/verify/chat-load.mjs --clients 1000 --senders 2 --messages 5 --backend spring
node server/verify/deploy-check.mjs           # 이 폴더의 단위 파일·환경 예시·설치 절차와 jar가 맞는지(Linux 없이, 포트 28080)
```

e2e가 하는 일: 이 디렉터리의 `mediamtx-relay.yml`을 그대로(포트·비밀·인증서만 환경변수) 실행, 중계 웹 서비스 실행(`--backend spring`이면 `frame-api.jar`, 기본은 이전 Node 중계), RTSPS 송출
인증(무인증·오비밀번호·미신뢰 인증서 거부, 정상 허용, 같은 경로 두 번째 송출 거부, 송출 PC별 계정이 남의 경로에 송출 불가),
송출 PC 쪽 MediaMTX(`writeQueueSize: 4096`)와 앱 방식의 전달 FFmpeg(복사, RTSPS, `-pkt_size 1190`, 재시작), 등록(계약 v1,
`sentAtMs` 시계 보정, 토큰별 경로)·썸네일 인증과 크기 제한, 재생 통계 CSV, `/info`의 `renditions`·`hls`, 영상 공백 중
`running:true`·`mediaReady:false`, MediaMTX API 지연 시 마지막 목록 유지, 주소별 제한이 토큰 비교보다 먼저, 채팅 규칙, 상한 503/429,
**HLS**: `live.m3u8`(원본 + 480p, AAC 그룹, 실제 CODECS, 두 시청자에게 같은 바이트, `?q=`), 미디어 재생 목록을 쿠키·
`index.m3u8` 없이 바로 받기, 캐시 헤더, 블로킹 재요청, 480p 즉시 기동, 모든 HLS 응답에 `Set-Cookie` 없음, AAC 없는 이전 송출의
AAC 변환 대체, 시청 세션(POST/PUT/DELETE)과 세션 기준 상한(503 + Retry-After, 세션 없는 클라이언트의 대체 집계),
**HLS DVR**: `dvr.m3u8`(EVENT, EXT-X-MAP 바이트 범위, 키프레임 세그먼트), `dvr/file` Range(206·416·접미 범위, 디스크 파일과 바이트
비교), 세그먼트 디코딩(H.264 + AAC, 프레임 수 = EXTINF), 오류 코드, FFmpeg HLS 디먹서로 처음부터 6 s 재생, 60 s 파일 경계의
DISCONTINUITY, 기존 `/dvr`·`/dvr/media`(이제 H.264 + AAC),
**방송 단위 주소** `/<path>/b/<id>/`: `/info`의 `hls.scope`, `live.m3u8`의 모든 URI가 접두사 아래로 풀림, 접두사 아래 미디어 재생
목록·init·part·세그먼트(HEAD 포함)·음성, `dvr`·`dvr.m3u8`·init 범위(경로 주소와 같은 바이트)·세그먼트, 다른 `id` 쿼리 409, 세션
POST/PUT/DELETE와 다른 id 접두사의 하트비트 409(세션 닫힘), 다른 방송 id의 모든 라우트 409 `no-store`, 방송 없는 경로 404,
`Set-Cookie` 없음. **같은 경로 재사용**(4.7): `bye` 뒤 이전 접두사 404, 다음 방송 등록 뒤 409(재생 목록·하위 목록·DVR·녹화 파일·세션),
이전 송출 세션이 남은 동안 새 방송 접두사 `503 + Retry-After`, 전달 FFmpeg 재시작 뒤 새 방송 재생(H.264), 새 방송 DVR에 이전 id
없음, 이전 id로 채팅 `join` 거절, 경로 주소는 새 방송을 줌, 등록보다 먼저 시작된 송출 세션(등록을 멈추고 전달 FFmpeg 재시작)은
다음 등록까지 접두사 아래 `503 + Retry-After`(경로 주소는 재생). (이 항목들은 2026-11-09에 추가했고, 같은 날 Node 대상과 2026-11-10 Spring 대상 실행에 포함됐다.)
헤드리스 Edge(실제 UI)에서 목록 클릭 → hls.js 재생(RTCPeerConnection 0개), 480p 전환, HTTP↔HTTPS(WSS) 채팅 왕복,
DVR 탐색(dvr.m3u8)과 실시간 복귀(live.m3u8), 페이지 종료 시 세션 DELETE, 중계 MediaMTX 재시작 후 자동 복구.
송출은 앱과 같이 H.264 + Opus(첫 음성) + AAC(둘째 음성, 시험음). HTTPS는 `server/tls-front.mjs`(자체 서명)로 재현한다.

2026-11-10 KST, 배포하는 백엔드를 Spring으로 바꾼 뒤의 실행(같은 PC, JDK 21.0.13, MediaMTX v1.21.3, FFmpeg 9.0.2, Edge 157 headless,
메이플스토리 실행 중, 1회 실행값이며 인터넷·실기기 결과가 아니다). 상세는 `../verification/spring/RESULTS.md`.
- Spring 대상(힙 256 MB): **108개 통과 / 0개 실패, 127 s**. Node 대상(비교 기준, 같은 날): 108개 통과 / 0개 실패, 120 s.
  - Node 대상의 앞선 1회 실행은 107개 통과 / 1개 실패였다(기록 파일 없음, 당시 실행 출력). 실패는 "Edge: 480p 전환 뒤 재생이 이어짐"으로,
    전환 직후 재생이 잠깐 멈춘 것이다(그 실행의 PC CPU 최대 79%). 아래 2026-11-02 13:17 기록과 같은 종류이고 재실행에서 통과했다.
- 채팅 1,000 연결(Spring, 힙 256 MB, `chat-load.mjs --backend spring`): 5.1 s에 1,000/1,000 입장, 10,000 전달 모두 수신, 전달 p50 21 ms /
  p95 42 ms, 입장 직후 프로세스 메모리 303 MB. Node(2026-10-28): p50 55 ms / p95 233 ms, 입장 직후 74 MB.
- 배포 파일 점검(`deploy-check.mjs`): 17/17. `relay.env.example`의 값으로(경로·포트·MediaMTX API 주소만 바꿔) jar가 설정 경고 없이
  시작하고(MediaMTX 미연결 경고는 제외), `JDK_JAVA_OPTIONS`가 적용되며, 루프백에서만 듣고, 설치한 화면·토큰 파일·통계 폴더가 동작한다.
  잘못된 값(범위 밖, rate 형식, 스위치 형식)으로는 시작하지 않고 로그에 이름이 나온다.
- Caddy 경유(`https-check.mjs`, 시험 Caddyfile): Spring 18 통과 / 0 실패 / 미실행 2, Node 18 / 0 / 2. 재시작 검사(H10)는 8장.

2026-11-02 15:29 KST 재실행(독립 코드 검토 21건 수정 후: WHEP 검증 경로만 전달, WHEP 상한 경쟁 조건, 녹화 파일 id = 녹화 시작 ms,
래더 실패 시 원본 대체·재시작 간격 증가): **93개 통과 / 0개 실패**, 94 s, PC CPU 평균 27%·최대 43%. 원본·480p PDT 차이 0 ms,
480p 전환 1201 ms(전환 뒤 2 s 동안 2.07 s 진행), 첫 프레임 HTTP 322 ms / HTTPS 319 ms, 원본 복귀 뒤 화질 라벨이 실제 높이(720p)와
일치(수정 전 실행은 480p로 남아 있었음). 아래 표는 수정 전 14:46 실행 값이다.

2026-11-02 14:46 KST 실행(화질 래더 적용 후, 같은 PC·같은 도구, 원본 testsrc2 1280×720 30 fps 3 Mbps + Opus + AAC 시험음,
PC 전체 CPU 평균 31%·최대 52%): **93개 통과 / 0개 실패**, 96 s. 1회 실행값이며 인터넷·실기기·CDN 결과가 아니다.
화질은 이제 방송마다 FFmpeg 하나(화질 래더, `server/lib/ladder.mjs`)가 원본 복사본 `src/`와 480p를 같은 시계로 만든다(3장 결정 3).

| 항목 | 측정값 |
|---|---|
| 목록 카드 클릭 → 첫 프레임(hls.js) | HTTP 319 ms, HTTPS 276 ms |
| hls.js 라이브 지연(`FrameRuntime.hls.latency`, 루프백) | HTTP 1.973 s, HTTPS 1.829 s, 480p 전환 뒤 1.596 s, DVR에서 실시간 복귀 뒤 1.74 s (화면 바코드 지연은 이 e2e에서 미측정) |
| 원본·480p 타임라인 정렬(두 재생 목록 동시 요청) | MEDIA-SEQUENCE 2 / 2, 가장 가까운 PROGRAM-DATE-TIME 차이 **0 ms** (새 검사, 기준 40 ms 이하) |
| 480p 수동 전환(UI 메뉴 → 854×480 표시) | 1081 ms, 전환 직후 2 s 동안 2.11 s 진행, 이어진 3 s 동안 3.02 s 진행(멈춤 없음; 이전 실행의 3 s 멈춤 해소) |
| 원본 복사본 `src/` 재생 목록 첫 요청 / 480p 첫 요청 | 2782 ms(래더가 방송 수신 직후 막 뜬 시점) / 3 ms(이미 준비됨) |
| 블로킹 재요청 | 2088 ms 대기 후 200 |
| DVR 탐색(dvr.m3u8) / 세그먼트 | 118 ms 뒤 재생, 고른 시각과의 차이 2955 ms(3 s 재생 포함) / EXTINF [4.00858, 4] s |
| 세션 기준 상한 | 상한 1: 두 번째 세션과 WHEP 503 + `Retry-After: 15`, 세션 없는 미디어 요청은 200(대체 집계로 셈), `Set-Cookie` 0 |

이전 실행(화질마다 따로 띄운 인코더, 아래)은 기록으로 둔다.

2026-11-02 13:17 KST 실행(검사 수정 후 2회째, Windows 11 한 대, 루프백, MediaMTX v1.21.3, FFmpeg 9.0.2, Node v24.22.1, Edge 156.0.4314.58 headless,
hls.js 1.5.20, 원본 testsrc2 1280×720 30 fps 3 Mbps + Opus 128k + AAC 128k, PC 전체 CPU 평균 75%·최대 99%,
다른 프로그램과 함께 사용 중): **91개 통과 / 1개 실패**, 102 s. 1회 실행값이며 인터넷·실기기·CDN 결과가 아니다.

| 항목 | 측정값 |
|---|---|
| 목록 카드 클릭 → 첫 프레임(hls.js) | HTTP 777 ms, HTTPS 469 ms (480p 인코더가 아직 꺼져 있을 때) |
| hls.js 라이브 지연(`FrameRuntime.hls.latency`, 루프백) | HTTP 2.546 s, HTTPS 1.704 s, 실시간 복귀 직후 8.002 s(복귀해 첫 프레임이 보인 순간의 값, CPU 최대 99% 실행; 앞선 실행은 1.744 s) (화면 바코드 지연은 이 e2e에서 미측정) |
| live.m3u8 / 블로킹 재요청 | 4 ms / 2026 ms 대기 후 200 (다음 세그먼트의 첫 part) |
| 480p 재생 목록 바로 요청(인코더 최초 기동 포함) | 2358 ms |
| 480p 수동 전환(UI 메뉴 → 854×480 표시) | 1422 ms, 전환 직후 2 s 동안 재생 진행 1.96 s, 이어진 3 s 동안 0 s(지연 2.271 → 5.25 s) |
| 원본·480p 타임라인 정렬 | 미측정: e2e가 남긴 값(notes)은 두 재생 목록을 약 5 s 간격으로(480p 인코더 기동 전후) 받은 것이라 비교가 성립하지 않는다 |
| DVR 탐색(dvr.m3u8) | 236 ms 뒤 재생, 고른 시각과의 차이 3059 ms(3 s 재생 포함) |
| dvr.m3u8 세그먼트 | [4.00881,4] s, init bytes 0-1217/*, 세그먼트 디코딩 120/120 프레임, FFmpeg 재생 180 프레임 오류 0개 |
| AAC 없는 이전 송출 | live.m3u8이 `aac/` 변환 경로 하나만 광고, AAC 재생 목록 최초 2381 ms(변환 FFmpeg 기동 포함) |

실패 항목(있으면): Edge: switch to relay 480p rendition plays 480 lines.
같은 날 앞선 1회 실행(검사 스크립트 수정 전)은 89개 통과 / 3개 실패였다: 상한 relay의 `RELAY_MAX_VIEWERS_PER_PATH`를 검사가 기대한
값(1)이 아니라 2로 띄운 검사 오류, ffprobe의 fMP4 "duration"(끝 시각)을 길이로 비교한 검사 오류, 480p 전환 직후 2 s 진행 0.94 s
(약 1 s 멈춤, 원인 미확인). 앞의 둘은 검사를 고쳤고, 셋째는 전환 직후 2 s를 따로 기록하고 그 뒤 3 s 재생으로 판정하게 했다. 고친 뒤 실행에서도 480p가
전환 2 s 뒤 3 s 동안 멈췄다(위 표, 원본으로 되돌리기는 통과). 원인은 확인하지 못했다: 이 실행의 PC CPU가 최대 99%였고(같은 PC의
libx264 480p 인코더·Edge 디코딩·다른 프로그램), 화질마다 MediaMTX 타임라인이 따로인 점(12장)이 후보다. 화면 브라우저 콘솔 기록은 남기지 않았다.
Edge(Chromium) 자체 HLS 재생기는 `live.m3u8`에서 오류 4(MEDIA_ERR_SRC_NOT_SUPPORTED)를 냈다(참고: Edge native HLS: {"canPlayType":"maybe","w":854,"t":0,"error":4}).
UI는 Edge에서 hls.js를 쓰므로 영향은 없지만 Safari 기본 HLS에서 같은 문제가 없는지는 실기기로 확인해야 한다.

이전 기록(2026-10-28/29, WebRTC 기본 시절, 아래 표):

2026-10-28 17:24 실행 결과(Windows 11 한 대, 루프백, MediaMTX v1.21.3, FFmpeg 9.0.2, Node v24.22.1, Edge 156 headless,
원본 testsrc2 1280×720 30 fps H.264 High B프레임 없음 1 s GOP 3 Mbps + Opus 128k, 실행 중 PC 전체 CPU 평균 55%·최대 86%,
다른 프로그램과 함께 사용 중). 1회 실행값이며 인터넷·실기기 결과가 아니다.

| 항목 | 측정값 |
|---|---|
| e2e 검사 | 78개 통과 / 1개 실패, 96 s (`verification/e2e-result.json`). 실패 1개는 아래 참고 |
| 목록 카드 클릭 → 첫 프레임(WebRTC) | HTTP 1.86 s, HTTPS 0.95 s (각 1회, 이후 3 s 동안 재생 위치 3.0 s 진행) |
| 480p(서버 측 공유 인코더 최초 기동 포함) 전환 | 5.2 s, 854×480 재생(`/info` 광고도 854×480, 1.8 Mbps, 30 fps, H.264) |
| 채팅 UI 왕복 ws→wss / wss→ws | 13 ms / 9 ms |
| 앱 방식 전달 FFmpeg(복사·RTSPS) 시작 → 중계 경로 준비 | 1.96 s (잘못된 비밀번호: 중계 거부, 로컬 시청 유지, 앱 재시도) |
| 중계 MediaMTX 재시작 → 전달 FFmpeg 재기동·복구 | 3.5 s(재시작 1회, 대기 1 s). 그동안 `/info` 20회 조회 중 `running:false` 0회, `mediaReady:false` 12회, WHEP 503 + `Retry-After: 2`. 송출 PC B의 송출(401)·등록(403) 가로채기 거부 |
| MediaMTX API 정지(7 s) | 마지막 정상 목록 유지(`mediamtxListStale`), `/info`·목록이 꺼짐으로 보인 횟수 0/8, 가장 느린 응답 1.5 s |
| `sentAtMs` | 60 s 앞선 송출 PC 시계를 보정(경과 3.1 s로 표시) |
| DVR | 60 s 세그먼트 경계를 하나의 구간(70.9 s)으로, 경계를 걸친 4 s 조각 정상(4.02 s), 실시간 끝 지연 0.2 s |
| HLS 첫 playlist(쿠키 확인 포함) | Opus 1.62 s, AAC(서버 변환 최초 기동) 2.0 s. Edge 156 기본 HLS 재생(6 s에 5.94 s 진행). AAC 변형에서 MediaMTX "part duration changed" 경고 8회 |
| 재생 통계 | 204, 같은 페이지 4 s 안 재전송 429(`Retry-After: 4`), 2 KB 초과 413, 형식 415, 모르는 경로 404, `sid` 없음 400. CSV 열 정확, IP 없음, UI 두 페이지의 15 s 보고 2줄 기록 |
| 상한·제한 | 시청자·채팅·소켓 상한 503 + Retry-After, 등록 폭주 45개 중 30개 허용, 틀린 토큰 10회 뒤 429 — 그 뒤 올바른 토큰도 429(`Retry-After: 6`) |
| 채팅 1,000 연결(이전 실행 `chat-load-1000x2.json`) | 5.9 s에 1,000/1,000 입장, 10,000 전달 모두 수신, 전달 p50 55 ms / p95 233 ms |

당시 실패 1개: "HLS 시청자를 시청자 상한에 포함" 검사. 동작(상한에서 WHEP·두 번째 HLS 시청자 503 + Retry-After, 이미 보던 HLS
시청자는 계속 200)은 맞았지만 `/healthz`의 `hlsViewers`가 1이 아니라 2였다(한 시청자를 두 번 셈 → 상한이 실제보다 일찍
걸림). 원인으로 보이는 두 곳을 고쳤다: e2e의 쿠키 저장이 값의 `=` 뒤를 잘라 보냄(브라우저와 다름), relay가 새 세션 쿠키를
받은 클라이언트의 이전 키를 지우지 않음.

2026-10-29 19:05:59~19:07:27 KST에 `node server/verify/e2e.mjs`를 다시 실행했다. **79개 통과 / 0개 실패**, 종료 코드 0,
약 87초다. 최신 `verification/e2e-result.json`과 증거 이미지는 이 재실행 결과다. 위 표의 개별 지연·성능 수치는
2026-10-28 측정 기록으로 유지한다. HLS 중복 집계는 `hlsViewers=1`로 확인했고, 상한 2에서 기존 HLS 요청은 200,
새 WHEP·HLS는 503 + `Retry-After: 15`, 기존 HLS 재요청은 200을 확인했다. 이 결과도 Windows 한 대의 루프백 검증이며
공개 인터넷과 실제 1,000명 미디어 시청 검증은 아니다.

`verification/logs/*.log`는 `.gitignore`(*.log) 대상이라 저장소에는 올라가지 않는다(로컬 증거, 비밀번호·토큰은 `***`로 가림).

## 12. 미검증

- 실제 서버·도메인·인증서(Let's Encrypt)·Caddy 실행, 다른 인터넷 회선, NAT/방화벽 환경, 실제 TURN.
- 실제 휴대폰(iPhone Safari, Android Chrome)의 WebRTC·HLS·오디오 정책. AAC LL-HLS의 iOS 호환(MediaMTX가 파트 길이 변경
  경고를 기록함). Safari 기본 HLS의 `live.m3u8`(별도 AAC 렌디션 그룹)·`?q=` 수동 화질·`dvr.m3u8`(BYTERANGE init, 재구성 세그먼트,
  `Content-Range: bytes a-b/*`) 재생. Edge 자체 HLS 재생기는 `live.m3u8`에서 오류 4(위 11장).
- CDN 앞단 전체(9장 규칙): 캐시 키, LL-HLS 블로킹 요청 묶기, Range 캐시, CDN 뒤 세션 집계와 `RELAY_TRUSTED_PROXIES`.
- 화질 사이 타임라인 정렬은 화질 래더로 맞췄다(11장: PDT 차이 0 ms). 다만 480p로 바꾼 직후 재생이 잠깐 멈추는 현상이 2026-11-10에
  두 백엔드 모두에서 간헐적으로 다시 나왔고 원인은 찾지 못했다(`../verification/spring/RESULTS.md`의 "480p 전환 직후의 간헐적 멈춤").
  남은 것: 래더가 막 뜬 직후
  약 5 s는 새 경로가 프레임을 받지 못한다(MediaMTX가 FFmpeg의 첫 RTCP 보고를 버림) — 그래서 미디어가 들어오면 미리 띄우고
  유휴 5분 뒤에만 멈춘다. 유휴로 멈춘 뒤 처음 들어온 시청자는 약 8 s 기다린다(앱 실측, relay는 미측정). 송출 PC가 직접 올리는
  하위 화질(RTSPS)은 래더 밖이라 원본과 정렬되지 않는다(현재 앱은 올리지 않음).
- Linux 서버의 libx264 래더 CPU(화질 수 × 해상도·fps)는 미측정. 무료 VM에서는 `RELAY_RENDITIONS`를 비워 두는 것을 권한다.
- relay를 거친 MediaMTX HLS 세션이 만료(401)된 뒤 다시 만드는 경로. 래더 재시작 뒤 이전 세션이 404를 받는 경우는 세션을 새로
  만들도록 고쳤고(래더 시작 때 그 경로의 세션도 버림), `server/verify/web-e2e.mjs` 6e에서 B의 480p 재생 목록이 바로 이어지는 것을
  확인했다(수정 전 약 40 s 404). 6 h 보존으로 지워진 녹화가 dvr.m3u8에서 빠지는 동작
  (오프라인 시험 파일로만 확인: MEDIA-SEQUENCE·DISCONTINUITY-SEQUENCE 증가), 긴 방송의 dvr.m3u8 크기(EXT-X-SKIP 없음).
- 시청 세션 heartbeat 만료(30 s)·IP 변경 시 키 이동·주소별 세션 상한(`RELAY_MAX_SESSIONS_PER_IP`)은 단위 시험만, HLS 부하(별도 담당).
- 1,000명 미디어 시청 부하(채팅 1,000 연결은 로컬 루프백으로만 측정), 장시간 운영의 메모리 추이, 작은 VM에서 JVM의 메모리와 기동 시간.
- Linux에서의 실행 전체(로컬 검증은 Windows 11). `frame-api.jar`(JVM)를 이 systemd 단위의 샌드박스(`ProtectSystem=strict`, `PrivateTmp`,
  `ReadOnlyPaths`) 아래에서 띄우기, `SuccessExitStatus=143`과 실제 종료 시간, 종료·재시작 때 FFmpeg 자식 정리, 배포판의 Java 21 패키지와
  `/usr/bin/java`, `LC_ALL=C.UTF-8`, MediaMTX 단위. Linux 쪽은 systemd·JDK·Spring Boot 문서와 소스 조사, 그리고 배포 파일과 jar의 정합 점검
  (`deploy-check.mjs`)까지만 했다.
- 화질 래더에 필요한 FFmpeg 최소 버전(6.1)과 Java 런타임 업데이트 뒤 재시작이 필요한 이유는 소스 확인뿐이다.
- RTSPS 인증서 갱신 시 MediaMTX가 새 인증서를 자동으로 읽는지(재시작 절차로 대신함).
- `Caddyfile.example` 자체는 실행하지 않았다. 같은 `encode … match`(응답 Content-Type 기준 압축), `response_header_timeout 45s`,
  `keepalive 60s` 지시문은 시험 설정(`test/Caddyfile.https-test`)으로 Windows의 Caddy v2.11.9에서 Spring과 Node 뒤 모두 실행했다
  (`../verification/spring/RESULTS.md`, `../verification/caddy/RESULTS.md`). 운영 예시는 React 공개 웹(`/_frame/`)을 아직 제공하지 않는다
  (시험 설정에만 있다).
- systemd `ReadWritePaths`(통계·VOD 보관 폴더)와 설치 절차의 권한(`chmod`를 파일에만)은 Linux가 없어 실행하지 않았다.
- 송출 PC가 직접 올리는 하위 화질(`<path>/<화질>`을 RTSPS로 받을 때만 그 PC의 설명을 광고) — e2e에 그 경우가 없다.
- 송출 PC `writeQueueSize: 4096`이 실제 혼잡한 업로드에서 전송 끊김을 막는지(e2e는 같은 PC 루프백이라 혼잡 없음).
