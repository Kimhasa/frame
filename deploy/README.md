# FRAME 인터넷 중계 서버 배포 안내

다른 인터넷 회선의 시청자가 브라우저만으로 방송을 보도록, Windows 송출 앱 앞에 두는 **중계 서버**의 구성·설치·운영 절차다.
설계 이유는 [DESIGN.md](DESIGN.md), 로컬 재현 결과는 [verification/](verification/)에 있다.

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
                                                       │   │ relay.mjs 127.0.0.1:8080 ◀─ Caddy :443 ◀── 브라우저
                                                       └──▶│  (UI, 목록, /info, WHEP·HLS·DVR 중계, 채팅 WSS) │
                                                           └──────────────────────────────────────────────┘
```

- 브라우저는 `https://<도메인>/` 하나만 연다. 화면(outputs/index.html)과 API는 송출 PC 내부 시청 서버와 같은 경로·JSON이라
  UI 코드는 그대로다(목록의 `baseUrl`이 중계 서버 주소로 바뀔 뿐).
- 송출 PC의 사설 IP, localhost, MediaMTX 관리 주소는 브라우저에 전달되지 않는다. 중계 MediaMTX의 API·녹화 조회·송출 기능도
  브라우저 쪽에서는 닿지 않는다(relay.mjs가 경로를 검사한 뒤 루프백으로만 넘김).

## 2. 파일

| 파일 | 용도 |
|---|---|
| `../server/relay.mjs`, `../server/lib/*.mjs` | 중계 웹 서비스(Node 22 이상, npm 의존성 없음) |
| `mediamtx-relay.yml` | 중계 MediaMTX 1.21.3 설정(비밀 없음, 환경변수로 덮어씀) |
| `mediamtx.env.example` | MediaMTX 비밀·공인 주소·인증서 경로 예시 |
| `relay.env.example` | relay.mjs 설정 예시(토큰은 파일로) |
| `Caddyfile.example` | HTTPS·WSS 역방향 프록시(인증서 자동) |
| `systemd/*.service` | 두 서비스의 systemd 단위 예시 |
| `../server/tls-front.mjs` | 로컬 검증용 HTTPS 앞단(Caddy 대용, 운영에 쓰지 않음) |
| `../server/verify/e2e.mjs`, `chat-load.mjs` | 로컬 재현 검증 스크립트 |

## 3. 서버 요구 사항

- Linux x86_64 또는 arm64, **공인 IPv4**(1:1 NAT 클라우드 VM이면 `MTX_WEBRTCADDITIONALHOSTS`에 공인 IP), UDP 수신 가능.
- 중계만 할 때(서버 측 화질 인코더 없음): 2 vCPU, RAM 2 GB 이상을 출발점으로 둔다. **실측 근거 없음** — 단계 부하 측정으로 정한다.
- 서버 측 하위 화질(`RELAY_RENDITIONS`)을 켜면 화질마다 FFmpeg(libx264) 1개: 720p30 대략 1코어(추정, 서버에서 측정 필요).
- 디스크: 녹화 = 원본 비트레이트 × 보존 시간. 8 Mbps × 6 h ≈ 21.6 GB(로컬 측정: 3 Mbps 약 70초에 28 MB).
- 소프트웨어: MediaMTX **v1.21.3**(앱과 같은 버전, 릴리스 체크섬 확인), Node.js 22 이상(로컬 검증은 v24.22.1),
  Caddy 2, (선택) FFmpeg(화질 인코더·AAC 변환).
- 회선: 송신 대역폭이 곧 수용 인원이다. 9장(예산)을 먼저 확인한다.

## 4. 포트와 방화벽

| 포트 | 공개 | 용도 |
|---|---|---|
| TCP 443, 80 | 예 | Caddy: HTTPS 페이지·API·WHEP·HLS·DVR·WSS 채팅, 80은 인증서 발급·리디렉트 |
| TCP 8322 | 예(송출 PC만 쓰면 송출 PC IP로 제한 가능) | RTSPS 송출 입력(TLS + 송출 계정) |
| UDP 8189 | 예 | WebRTC 미디어(기본) |
| TCP 8189 | 예 | WebRTC 미디어 대체(UDP 차단 망) |
| 127.0.0.1: 8080, 8554, 8888, 8889, 9996, 9997, 9998 | **아니오** | relay.mjs, 평문 RTSP(서버 내 인코더), HLS, WHEP HTTP, playback, API, metrics |

클라우드 보안 그룹과 호스트 방화벽(예: `ufw allow 443/tcp`, `80/tcp`, `8322/tcp`, `8189/udp`, `8189/tcp`)을 **둘 다** 연다.
루프백 포트는 열지 않는다. `ss -ltnup`로 9997·9996 등이 127.0.0.1에만 묶였는지 확인한다.

## 5. 설치 절차(예: Ubuntu)

```sh
# 0) 계정과 폴더
sudo useradd --system --home /var/lib/frame-relay --shell /usr/sbin/nologin frame-relay
sudo install -d -o frame-relay -g frame-relay -m 750 /var/lib/frame-relay /var/lib/frame-relay/stats
sudo install -d -m 750 -g frame-relay /etc/frame-relay /etc/frame-relay/tls
sudo install -d /opt/frame-relay/ui/assets/fonts

# 1) 프로그램: 이 저장소의 server/ 와 빌드된 화면(outputs/index.html + outputs/assets/fonts)
sudo cp -r server /opt/frame-relay/
sudo cp outputs/index.html /opt/frame-relay/ui/
sudo cp outputs/assets/fonts/PretendardVariable.woff2 outputs/assets/fonts/OFL.txt /opt/frame-relay/ui/assets/fonts/
# MediaMTX v1.21.3 linux 바이너리를 /usr/local/bin/mediamtx 로(체크섬 확인 후)
sudo cp deploy/mediamtx-relay.yml /etc/frame-relay/

# 2) 비밀: 송출 PC마다 계정 비밀번호(해시만 서버에)와 토큰, 공인 주소. 예: 송출 PC 1 = frame-sender-01 / screen-01
PASS1=$(openssl rand -hex 24)       # 송출 PC 1 설정에 넣을 원문. 안전한 경로로 전달하고 셸 기록에 남기지 않는다.
HASH1=$(printf %s "$PASS1" | openssl dgst -binary -sha256 | openssl base64)
TOKEN1=$(openssl rand -hex 32)      # 송출 PC 1의 등록·썸네일 토큰
echo "$TOKEN1 screen-01" | sudo tee /etc/frame-relay/publisher-tokens >/dev/null   # 송출 PC마다 "<토큰> <경로>" 한 줄(tee -a)
sudo cp deploy/mediamtx.env.example /etc/frame-relay/mediamtx.env   # MTX_AUTHINTERNALUSERS_1_PASS=sha256:$HASH1 ..., 공인 IP 기입
sudo cp deploy/relay.env.example /etc/frame-relay/relay.env         # RELAY_PUBLIC_BASE_URL 등 기입
# 파일에만 640을 준다. "chmod 640 /etc/frame-relay/*"는 tls/ 폴더의 실행(x) 비트까지 지워 frame-relay 계정이
# rtsps.key를 못 읽게 되고 mediamtx-relay가 시작하지 않는다. 폴더는 0)에서 만든 750을 유지한다.
sudo chown root:frame-relay /etc/frame-relay/*.env /etc/frame-relay/publisher-tokens /etc/frame-relay/mediamtx-relay.yml
sudo chmod 640 /etc/frame-relay/*.env /etc/frame-relay/publisher-tokens /etc/frame-relay/mediamtx-relay.yml

# 3) HTTPS: Caddy
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile   # 도메인 수정
sudo systemctl reload caddy

# 4) RTSPS 인증서: Caddy가 받은 인증서(또는 certbot)를 복사. 갱신 후 다시 복사하고 mediamtx-relay를 재시작한다.
#    Caddy 기본 저장 위치 예: /var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<도메인>/
sudo install -m 640 -g frame-relay <도메인>.crt /etc/frame-relay/tls/rtsps.crt
sudo install -m 640 -g frame-relay <도메인>.key /etc/frame-relay/tls/rtsps.key

# 5) 서비스
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx-relay frame-relay
```

설치 확인:

```sh
curl -s https://<도메인>/healthz                 # {"ok":true,"mediamtx":true,...}
curl -s http://127.0.0.1:9997/v3/paths/list       # 서버 안에서만. 송출 후 ready:true
ss -ltnup | grep -E '8189|8322|9997|9996|8080'    # 9997·9996·8080은 127.0.0.1이어야 함
```

`MTX_WEBRTCADDITIONALHOSTS`가 비어 있으면 MediaMTX가 시작하지 않는다(설정 오류로 열린 채 시작하지 않도록 의도한 동작,
로컬에서 확인). `MTX_AUTHINTERNALUSERS_<번호>_PASS`를 빠뜨린 계정은 yml의 자리표시 해시 때문에 송출이 거부된다.

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
     `scale=-2:H` 결과 그대로라 1280×720의 480p는 854×480), `hlsVariants`(`{"opus":"hls/index.m3u8","aac":"aac/hls/index.m3u8"}`,
     `<origin>/<path>/` 기준. `aac`는 `RELAY_HLS_AAC=1`일 때만 — iPhone Safari처럼 HLS는 되지만 fMP4 Opus를 못 트는 브라우저용).
   - 영상만 잠깐 끊기면(송출 PC 재연결, 중계 MediaMTX 재시작) `/info`는 등록이 살아 있는 동안 `RELAY_MEDIA_GRACE_MS`(15초)까지
     `{"running":true,"mediaReady":false}` + `Retry-After: 2`, WHEP·HLS는 `503 + Retry-After`를 준다. UI는 이때 "송출 종료"로
     끝내지 말고 기다렸다 다시 연결해야 한다. 지금 UI는 첫 연결(`connect()`)만 `Retry-After`를 따르고(최대 4회), 재연결
     (`lost()`)은 `Retry-After`를 무시하고 3회 뒤 재생을 끝낸다 — `mediaReady:false`를 대기로 처리하도록 UI 수정이 필요하다.
   - 상한: 시청자 수(WebRTC + 최근 `RELAY_HLS_ACTIVE_MS` 안의 HLS 시청자)·소켓 수·채팅 수 초과는 `503 + Retry-After`.
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
  `RELAY_TURN_SECRET`에 넣으면 relay.mjs가 `/info` 요청마다 `만료시각:frame` 사용자와 HMAC 자격 증명을 만든다
  (`RELAY_TURN_TTL_S`, 기본 3600초). UI는 연결·재연결 때마다 `/info`를 다시 받으므로 새 자격 증명을 쓴다.
  장시간 시청 중 TURN 할당 갱신이 만료 이후에도 허용되는지는 TURN 서버 구현에 따라 다르다 — **실제 TURN으로 미검증**.
  시청 시간이 긴 방송이면 TTL을 예상 최대 시청 시간보다 길게(예: 43200) 두고, 유출 시 영향(그 시간 동안 TURN 사용 가능)을 감수한다.
- 확인 방법: 시청 PC에서 `edge://webrtc-internals`(Chrome은 `chrome://webrtc-internals`)의 선택된 candidate pair가
  `host`(서버 공인 IP)·`udp`인지, `tcp`인지, `relay`(TURN)인지 본다. 페이지는 열리는데 영상만 안 나오면 미디어 경로(8189) 문제다.

## 8. 재시작·진단

| 증상 | 확인 |
|---|---|
| 페이지 안 열림 | `systemctl status caddy frame-relay`, DNS, 443 방화벽, `journalctl -u caddy` |
| `/healthz` 503 | MediaMTX API 응답 없음: `systemctl status mediamtx-relay`, `journalctl -u mediamtx-relay -n 100` |
| 목록이 비어 있음 | 송출 PC의 등록 응답(401/403/409/429), `X-Frame-Media-Ready: 0`이면 RTSPS 송출 실패: `journalctl -u mediamtx-relay | grep -i -E 'authenticat|RTSPS'` |
| 송출 거부 | `failed to authenticate`(비밀번호, 또는 그 계정에 배정되지 않은 경로), `someone is already publishing`(같은 경로 사용 중), 인증서 검증 실패(송출 PC 쪽 로그) |
| 영상만 안 나옴 | UDP/TCP 8189 방화벽, `MTX_WEBRTCADDITIONALHOSTS`가 실제 공인 IP인지, webrtc-internals의 candidate |
| 채팅 끊김 | Caddy 로그의 101 응답, relay 로그 `chat connection limit`, 프록시 유휴 시간(서버가 25초마다 ping) |
| DVR 없음 | `RELAY_DVR`, 녹화 폴더 쓰기 권한·디스크 여유, `curl http://127.0.0.1:9996/list?path=<path>` |
| 목록이 잠깐 비거나 `/healthz`의 `mediamtxListStale:true` | MediaMTX API가 느림·실패: 마지막 정상 목록을 `RELAY_MEDIAMTX_STALE_MS`(15초) 동안 유지하고 그 뒤 비운다 |
| 재생 통계가 안 쌓임 | `RELAY_STATS_DIR` 설정·쓰기 권한(systemd `ReadWritePaths`), 로그 `playback stats`, 하루 50 MB 상한 |

- 재시작: `sudo systemctl restart mediamtx-relay`(송출 PC의 전달 FFmpeg가 다시 떠서 재연결. 그동안 시청자는 "송출 종료"가 아니라
  `mediaReady:false`로 대기),
  `sudo systemctl restart frame-relay`(목록은 다음 등록(2초 이내)에 복구, 채팅방 기록은 메모리라 초기화됨).
- 로그에는 토큰·비밀번호·채팅 본문·SDP를 쓰지 않는다. 거부 사유는 같은 IP·사유당 1분에 1줄.
- MediaMTX 지표: 서버 안에서 `curl http://127.0.0.1:9998/metrics`(경로별 송수신 바이트, 세션 수).

## 9. 무료 자원·트래픽 예산 (NET-10)

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

## 10. 로컬 재현 검증

```sh
node server/verify/e2e.mjs          # 약 3~4분(헤드리스 Edge 포함). 포트 24000-24999만 사용. 결과: deploy/verification/e2e-result.json, *.png, logs/
node server/verify/chat-load.mjs --clients 1000 --senders 2 --messages 5
```

e2e가 하는 일: 이 디렉터리의 `mediamtx-relay.yml`을 그대로(포트·비밀·인증서만 환경변수) 실행, relay.mjs 실행, RTSPS 송출
인증(무인증·오비밀번호·미신뢰 인증서 거부, 정상 허용, 같은 경로 두 번째 송출 거부, 송출 PC별 계정이 남의 경로에 송출 불가),
송출 PC 쪽 MediaMTX(`writeQueueSize: 4096`)와 앱 방식의 전달 FFmpeg(복사, RTSPS, `-pkt_size 1190`, 재시작), 등록(계약 v1,
`sentAtMs` 시계 보정, 토큰별 경로)·썸네일 인증과 크기 제한, 재생 통계 CSV, `/info`의 `renditions`·`hlsVariants`, 영상 공백 중
`running:true`·`mediaReady:false`, MediaMTX API 지연 시 마지막 목록 유지, HLS 시청자의 상한 포함, 주소별 제한이 토큰 비교보다 먼저, `/info`·목록·DVR·HLS(Opus, AAC), 채팅 규칙, 상한 503/429,
헤드리스 Edge에서 목록 클릭 → WebRTC 재생, 480p 전환, HTTP↔HTTPS(WSS) 채팅 왕복, DVR 탐색과 실시간 복귀,
Edge 기본 HLS 재생, 세션 정리, 중계 MediaMTX 재시작 후 자동 복구. HTTPS는 `server/tls-front.mjs`(자체 서명)로 재현한다.

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

## 11. 미검증

- 실제 서버·도메인·인증서(Let's Encrypt)·Caddy 실행, 다른 인터넷 회선, NAT/방화벽 환경, 실제 TURN.
- 실제 휴대폰(iPhone Safari, Android Chrome)의 WebRTC·HLS·오디오 정책. AAC LL-HLS의 iOS 호환(MediaMTX가 파트 길이 변경
  경고를 기록함).
- 1,000명 미디어 시청 부하(채팅 1,000 연결은 로컬 루프백으로만 측정), 장시간 운영의 메모리 추이.
- Linux에서의 relay.mjs·MediaMTX·systemd 단위 실행(로컬 검증은 Windows 11).
- RTSPS 인증서 갱신 시 MediaMTX가 새 인증서를 자동으로 읽는지(재시작 절차로 대신함).
- Caddy의 `encode … match`(응답 Content-Type 기준 압축)와 `response_header_timeout 45s`, systemd `ReadWritePaths`(통계 폴더),
  설치 절차의 권한(`chmod`를 파일에만) — Linux·Caddy가 없어 실행하지 않았다.
- 송출 PC가 직접 올리는 하위 화질(`<path>/<화질>`을 RTSPS로 받을 때만 그 PC의 설명을 광고) — e2e에 그 경우가 없다.
- 송출 PC `writeQueueSize: 4096`이 실제 혼잡한 업로드에서 전송 끊김을 막는지(e2e는 같은 PC 루프백이라 혼잡 없음).
