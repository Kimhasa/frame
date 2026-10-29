# FRAME 단일 방송 부하 시험 도구 (tools/load)

한 방송을 **실제 미디어를 받는** 시청자 N명으로 단계별로 늘리며 성공률·첫 미디어 시간·끊김·비트레이트·채팅·DVR·자원을 기록한다.
HTTP 200이나 WHEP 201만으로는 성공으로 세지 않는다. 결과는 `verification/load/<runId>/`에 `results.json`, `stages.csv`, `samples.csv`로 남는다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `run-load.mjs` | 단계 부하 실행기. 램프업·유지·동시 입장·교체(churn)·화질 혼합·채팅·DVR·실제 브라우저 표본·자원 샘플링·중단 규칙·결과 저장 |
| `lib/generator.mjs` | 부하 발생기. 별도 MediaMTX(자체 설정·API 포트 21900+)에서 시청자 1명 = `source: whep://…` 경로 1개. 각 시청자는 ICE·DTLS-SRTP·RTCP를 하는 실제 WebRTC peer이며 H.264/Opus를 받아 depacketize만 하고 디코딩하지 않는다 |
| `lib/chat.mjs` | `/<path>/chat` WebSocket(native/src/chat.cpp 프로토콜: `/info`의 broadcastId로 join → send). 보낸 시각을 메시지에 넣어 같은 프로세스의 다른 소켓에서 받은 시각으로 전달 지연 p50/p95와 전달률을 잰다 |
| `lib/dvr.mjs` | `/<path>/dvr` 색인 조회 후 `/<path>/dvr/media?id=&start=&duration=` 조각을 임의 과거 위치에서 받아 오류율·TTFB를 잰다 |
| `lib/resources.mjs`, `sampler.ps1` | 발생기(node + MediaMTX)·브라우저 표본·대상 프로세스의 CPU/메모리, 호스트 CPU/메모리, NIC 송수신, nvidia-smi GPU/인코더 사용률 |
| `browser-sampler.mjs` | 헤드리스 Edge(자체 프로필·DevTools 포트 21222) K개 페이지: 첫 프레임 시간, 표시 FPS(requestVideoFrameCallback), 500 ms 초과 멈춤, 디코딩 해상도·FPS, getStats 손실·지터, 바코드가 있으면 캡처→표시 지연 |
| `summarize.mjs` | 결과 폴더를 표로 출력(`node tools/load/summarize.mjs verification/load/<runId>`) |
| `host-sampler.mjs` | 발생기를 다른 PC에서 돌릴 때 송출 PC에서 FrameConsole.exe 프로세스 트리·업로드·GPU 인코더를 기록 |
| `target.mjs`, `lib/app-shim.mjs` | 앱 없이 쓰는 독립 대상: MediaMTX(streamer.cpp와 같은 스트리밍 설정, 포트 215xx/218xx/219xx) + FFmpeg testsrc2 1080p60 H.264(High, B-frame 없음, GOP 1 s) + Opus, 선택적 하위 화질(runOnDemand)·DVR 녹화, 그리고 앱의 `/info`·WHEP 프록시·`/chat`·`/dvr`을 흉내 내는 Node 대역(shim) |
| `plans/*.json` | 시험 프로필 |

포트: 이 도구는 21000–21999만 쓴다(대상 21554/21889/21189/21996/21997, shim 21888, 발생기 API 21900+, Edge 21222).
8554·8889·8189 등 앱 포트는 열지 않는다(실제 앱을 시험할 때는 앱이 연 8889에 **접속**만 한다).

## 정의 (results.json `definitions`에도 기록)

- **시청자**: 발생기 MediaMTX의 WHEP 소스 1개. 미디어를 실제로 받지만 디코딩·렌더링은 하지 않는다.
- **수신 중**: 표본 창(기본 2 s)에서 받은 바이트가 `stallKbps`(기본 0) 초과로 늘었다.
- **첫 미디어**: 입장 요청 시각(램프 슬롯, 동시 입장이면 동시 입장 시작 시각 = 32개 동시 요청 뒤 대기 포함, 교체 재입장 시각) → 발생기 경로가 `ready`이고 트랙이 있고 받은 바이트가 0보다 큰 시점. 시각은 경로의 `readyTime`(트랙 수집 = 첫 RTP)을 쓰되, MediaMTX의 0년 자리표시(`0001-01-01…`)와 그 세션 요청 이전 시각은 버린다. 쓸 수 있는 시각이 없으면 표본 시각을 쓰고 `firstMediaMs.basis`·`firstMediaFromSampleClock`에 따로 센다(오차 ≤ 표본 간격). 0년 → 실제 시각 전환은 재접속으로 세지 않는다. 단계 끝에 아직 기다리는 입장은 시간 초과가 아니라 `firstMediaPending`.
- **지속 수신 성공**: 첫 미디어를 받고 유지 구간 창의 95% 이상에서 수신 중. `successRate = 지속 수신 / 요청 인원`.
- **끊김(stall)**: 표본 창 동안 증가 없음. `stallTimeRatio = 끊긴 시간 / 첫 미디어 이후 관찰 시간`. 300 kbit/s 미만 창은 `lowRateWindowRatio`로 따로 표시(오디오만 오는 경우 탐지).
- **전체 속도 성공**(`fullRateSuccessRate`): 지속 수신이면서 시청자가 유지 구간에 본 화질 구간마다 평균 수신 속도가 **그 화질의** 기준 속도의 90% 이상(하위 화질도 원본이 아니라 자기 화질 경로 기준으로 판정, 기준이 없는 화질이 있으면 "not measured"). 기준(`reference.<화질>.from`)은 대상이 받는 그 경로의 수신 속도(독립 대상 MediaMTX API 또는 앱 `/api/stats`의 `paths.<경로>.bytesReceived` 증가분), 없으면 `referenceKbps`, 그것도 없으면 첫 단계(그 화질 2명 이하)의 시청자 속도. 시청하지 않아 수신 0인 화질 경로는 기준이 아니다. 교체로 모든 화질 구간이 4 s 미만인 세션은 판정에서 빼고 `fullRateTooShort`로 센다. **바이트가 늘기만 하는 것으로는 부족하다**: 대상이 느린 읽기 쪽 프레임을 버리면(`targetDiscardedFrames`) 수신은 계속되지만 화면은 깨진다. 이 PC 시험에서 바로 이 경우가 나왔다.
- **원본 대비 수신율**(`rateVsSource`): 위 기준 대비 시청자 수신 속도 p5/p50과 0.9 미만 인원(`degradedViewers`).
- **교체(churn)가 있을 때**: 유지 구간 내내 남는 시청자가 없으므로 유지 구간에 나타난 시청자 세션마다 자기 창으로 판정하고, 성공률 분모는 측정된 세션 수다(`successBasis`).
- **CPU%**: 기계 전체(모든 논리 CPU) 대비. `cores`는 같은 값을 코어 수로.
- 디코딩 FPS·렌더링·A/V 동기·플레이어 재버퍼링·라이브 지연은 프로토콜 시청자로 잴 수 없어 **"not measured"**로 남긴다. 브라우저 표본(`browser` 필드) 값만 실제 재생 지표다.

## 중단 규칙 (plan.limits, 단계 중 즉시 기록)

| 이유 | 조건(기본값) |
| --- | --- |
| `generator-cpu` | 발생기 프로세스 CPU > 90% 30 s 지속 |
| `host-cpu` | 호스트 CPU > 95% 30 s 지속(발생기와 대상이 같은 PC면 어느 쪽이 더 썼는지 함께 기록) |
| `success-below-min` | 유지 구간 수신 비율 < 90% 20 s 지속 |
| `degraded-below-min` | 자기 화질 기준의 90% 이상을 받는 시청자 비율(`fullRateLive`, 10 s 이동 창) < `minFullRate`(0.9) 20 s 지속. 기준은 대상 통계(MediaMTX API 또는 앱 `/api/stats`)의 화질별 수신 속도. `abortOnDegraded: false`면 기록만 |
| `whep-503-share` | 최근 30 s WHEP 제안 중 503 비율 ≥ `max503Share`(0.1, 제안 20개 이상) 10 s 지속. WHEP 탭이 상태 코드와 Retry-After를 기록 |
| `target-not-running` | `/info`가 running이 아니거나 `/api/stats` `running: false` |
| `quality-not-offered` | 플랜의 하위 화질이 `/info` renditions에 없다(시작 전) |
| `stop-file` | 결과 폴더에 `STOP` 파일을 만들면 시청자를 정리하고 결과를 쓴 뒤 끝낸다(백그라운드 실행 중단용). Ctrl+C 1회도 같고, 2회면 즉시 종료 |
| `target-process-died` | 대상 핵심 프로세스(PID 지정, 트리 루트, FrameConsole/mediamtx) 종료 |
| `traffic-cap` | 발생기 누적 수신량 ≥ `maxTrafficGB`(기본 50 GB) |
| `host-memory` | 남은 메모리 < 300 MB 10 s 지속 |
| `generator-event-loop` / `generator-died` | node 이벤트 루프 지연 p99 > 1 s 30 s / 발생기 MediaMTX 종료 |

중단 전이라도 처음 넘은 한계는 `saturation` 목록에 시간순으로 남는다(발생기 CPU, 호스트 CPU, 대상 CPU, NIC 링크 80%, GPU 인코더 90%, 대상의 프레임 폐기, 수신 비율 90% 미만, 발생기 API 지연). **PERF-08: 발생기나 같은 PC의 자원이 먼저 포화되면 서버 한계로 결론 내리지 않는다.**

## 실행

### 1) 독립 대상으로 도구 확인 (이 PC 한 대)

```powershell
node tools/load/target.mjs --dir $env:TEMP\frame-load-target --record --renditions 720p,480p --duration 3600
# 다른 창에서
node tools/load/run-load.mjs --plan tools/load/plans/smoke-local.json --target-state $env:TEMP\frame-load-target\state.json
node tools/load/run-load.mjs --plan tools/load/plans/local-stages.json --target-state $env:TEMP\frame-load-target\state.json
node tools/load/run-load.mjs --plan tools/load/plans/calibrate-local.json --target-state $env:TEMP\frame-load-target\state.json
node tools/load/run-load.mjs --plan tools/load/plans/mixed-local.json --target-state $env:TEMP\frame-load-target\state.json
node tools/load/run-load.mjs --plan tools/load/plans/chat-1000-local.json --target-state $env:TEMP\frame-load-target\state.json
node tools/load/summarize.mjs verification/load/<runId>
# PERF-01 단일 시청 기준선(같은 시계의 캡처->표시 지연): 대상을 --source live로 다시 시작한 뒤
node tools/load/run-load.mjs --plan tools/load/plans/perf01-live-local.json --target-state <state.json>
# 동시 입장(입장 폭주): 단계마다 0명에서 전원이 한꺼번에 들어온 뒤 나가고, 대상 세션 수가 0으로 돌아오는지 확인
node tools/load/run-load.mjs --plan tools/load/plans/burst-local.json --target-state <state.json>
```

- `--source clip`(기본): testsrc2를 앱 인코더 인자(NVENC CBR 8 Mbps, `-bf 0 -g 60`)로 한 번 인코딩한 20 s 클립을 stream copy로 반복 송출. 송출기 CPU가 거의 0이라 호스트 CPU가 MediaMTX와 시청자에 쓰인다. ffprobe 결과(High, has_b_frames 0, 키프레임 1 s, 실제 비트레이트)를 state.json `clip`에 남긴다.
- `--source live`: testsrc2를 실시간 인코딩하고 프레임마다 벽시계 바코드(tools/motion-test.html 형식)를 넣는다. 브라우저 표본이 캡처→표시 지연을 잰다. 1080p60 생성에 노트북에서 약 2코어를 쓴다.
- `--webrtc-bind 0.0.0.0`: 다른 PC의 발생기가 대상 MediaMTX WHEP에 직접 붙을 때.
- shim은 앱의 C++ 서버가 아니다. 채팅·DVR·WHEP 프록시 **동작 확인용**이며 그 수치는 FrameConsole 수용량이 아니다. 상한은 c54c07d 앱과 같은 채팅 300 / HTTP 400이 기본이고(현재 앱 소스는 바뀌었을 수 있다) `--chat-limit 1100 --http-limit 1300`으로 올려 클라이언트 쪽 1,000 연결을 확인할 수 있다.
- shim은 `dist/FrameConsole/ui/index.html`(실제 시청 UI)을 `/screen-01`로 내준다. 브라우저 표본은 이 UI를 연다. UI의 자동 화질은 플레이어 크기를 보므로 창 크기(`--window 1920,1080` 기본)에 따라 하위 화질로 바뀔 수 있고, 표본은 바뀐 `<video>`와 새 peer connection을 따라가며 `videoElementSwitches`·`peerConnectionLog`에 남긴다.

### 2) 실제 앱 대상

앱 통계 계약(읽기 전용, 앱 8889): `GET /api/stats` → `{"v":1,"timeMs":ms,"running":bool,"paths":{"screen-01":{"ready","readers","bytesReceived","bytesSent"},"screen-01/720p":{…}},"webrtc":{"sessions","bytesSent","bytesReceived"},"mediaDiscardWarnings":n,"http":{"threads","requests","refused"},"chat":{"clients","joined","refused"}}`.
실행기는 2 s마다 이것을 읽어 대상 세션 수(`targetSessions`), 송신 속도(`targetSendMbps`), 화질별 수신 속도(전체 속도 기준), 프레임 폐기 경고(`appDiscardWarnings`), HTTP/채팅 거절 수를 기록하고 중단 규칙(`degraded-below-min`, `success-below-min`, `whep-503-share`, `generator-cpu`/`host-cpu`/`host-memory`, `target-not-running`)에 쓴다. 속도는 앱 스냅샷 시각(`timeMs`) 차이로 계산한다(앱이 1 s 캐시하므로 같은 스냅샷은 건너뜀). 앱의 `webrtc.bytesSent`는 열린 세션 합이라 세션이 닫히면 줄어든다. 그 표본의 송신 속도는 비워 둔다(교체 실행에서는 하한값).
실제 앱 플랜(`real-app*.json`, `soak.json`)은 `/api/stats`가 v 1로 답하지 않으면 시작하지 않는다(`--allow-no-app-stats --reference-kbps source=8600`으로만 우회).

리드가 이 PC(송출 PC = 발생기 PC, 루프백)에서 돌릴 명령. FrameConsole로 `screen-01` 방송을 먼저 시작하고 `http://127.0.0.1:8889/screen-01`이 재생되는지 확인한다. 결과는 `verification/load/<runId>/`(`--out <폴더>`로 바꿀 수 있다).

```powershell
# 통계 계약 확인(읽기만 한다)
curl.exe -s http://127.0.0.1:8889/api/stats
# 1) 단일 방송, 원본 화질, 1-10-25-50-75-100명, 단계당 유지 45 s. 이 PC의 루프백 한계(약 50-75명) 너머는 중단 규칙이 끝낸다.
node tools/load/run-load.mjs --plan tools/load/plans/real-app.json --host 127.0.0.1
# 2) 혼합: 원본/720p/480p + 채팅 + DVR 10% + 교체, 10-25-50명 (앱 설정에 720p·480p 화질이 켜져 있어야 한다)
node tools/load/run-load.mjs --plan tools/load/plans/real-app-mixed.json --host 127.0.0.1
# 3) 채팅만 1,000 소켓 (100-300-500-1000)
node tools/load/run-load.mjs --plan tools/load/plans/real-app-chat-1000.json --host 127.0.0.1
# 결과 표
node tools/load/summarize.mjs verification/load/<runId>
```

- 송출 PC가 다른 PC면 `--host <송출 PC IP>`. 경로가 `screen-01`이 아니면 `--path <경로>`.
- 자주 쓰는 덮어쓰기: `--stages 1,10,25`(플랜 단계 대신, 보정 플랜에서도 우선), `--hold 30`, `--ramp-per-sec 5`, `--browser 0`(브라우저 표본 끄기), `--max-traffic-gb 20`, `--out <폴더>`, `--name <이름>`.
- 실행 중 끝내기: 결과 폴더에 빈 `STOP` 파일을 만들거나 Ctrl+C 1회(시청자 정리 후 결과 기록). 2회면 즉시 종료.
- 같은 PC에서는 플랜의 `target.tree: ["FrameConsole"]`로 앱 프로세스 트리(MediaMTX·FFmpeg 포함)의 CPU/메모리를 대상 몫으로 따로 잰다. 루프백 트래픽은 NIC를 지나지 않으므로 업로드 한계는 잴 수 없다.
- 브라우저 표본(데스크톱 1 + 모바일형 1, 20 s)은 `real-app.json`에서 1명·10명 단계의 유지 구간이 끝난 뒤 별도 단계로만 돈다. 유지 구간 수치에는 들어가지 않는다.
- 트래픽 상한은 계획된 단계를 다 돌릴 수 있게 잡았다(real-app 40 GB: 8.6 Mbit/s에서 약 16 GB, real-app-mixed 20 GB, real-app-burst 30 GB). 보호는 중단 규칙이 한다.
- 발생기를 다른 PC에서 돌릴 때: 송출 PC에서 `node tools/load/host-sampler.mjs --tree FrameConsole --name sender`(두 PC 시계는 NTP로 맞춘다). 여러 생성기 PC는 `--generator-id pc2`처럼 서로 다른 id를 준다(채팅 이름 충돌 방지).
- 동시 입장: `real-app-burst.json`(25-50-75-100명, 단계마다 0명에서 시작). 장시간: `soak.json --stages <마지막 통과 단계>`.

### 앱 없이 실제 앱 경로 확인 (자체 점검)

shim이 같은 `/api/stats`를 내주므로, 앱 경로(WHEP 프록시 + `/api/stats`만 사용, MediaMTX API 미사용)를 앱 없이 확인할 수 있다.

```powershell
node tools/load/target.mjs --dir $env:TEMPrame-load-target --renditions 720p --duration 900
node tools/load/run-load.mjs --plan tools/load/plans/selfcheck-appstats-local.json --target-state $env:TEMPrame-load-targetstate.json --stages 1,10,25 --hold 20
```

### 3) 안전 상한

- **트래픽**: 8 Mbps × 1,000명은 영상만 약 8 Gbps, 60 s에 약 60 GB. 인터넷·유료 회선에서는 `--max-traffic-gb`를 반드시 정하고 짧은 유지 시간으로 시작한다. 무료 서비스·유료 자원은 이 도구가 만들지 않는다.
- **발생기 한계 먼저**: `calibrate-local.json`으로 발생기 PC가 몇 세션을 받을 수 있는지(`results.json` `calibration`) 먼저 확인하고, 그보다 큰 단계는 발생기를 여러 PC로 나눈다(각 PC에서 같은 플랜을 `--stages`로 나눠 동시에 실행).
- `generator.instances`로 한 PC에서 발생기 MediaMTX를 여러 개로 나눌 수 있다(API 포트 21900+i).

## 결과 파일

- `results.json`: 명령줄, 플랜, 도구 버전, 호스트 사양, 시작 전 기준 부하(`hostBaseline`, 공유 PC의 다른 프로그램 부하 포함), 대상 정보, 정의, 미측정 목록, 단계별 결과, 중단 이유, 포화 순서, 보정 결과, 정리(세션 0 복귀·자원 회복).
- `stages.csv`: 단계당 한 행(요청/측정 인원, 성공률, 첫 미디어 p50/p95, 끊김 비율, 시청자당·전체 비트레이트, 손실, 채팅·DVR, 자원, 브라우저 표본, 중단 이유).
- `samples.csv`: 2 s마다(자원은 3 s) 한 행.
- `generator-*.log`: 발생기 MediaMTX의 WAR/ERR(패킷 손실·연결 오류).

## 측정 한계

- 프로토콜 시청자는 디코딩하지 않으므로 FPS·화면·A/V 동기·재버퍼링은 브라우저 표본(기본 2개)에서만 나온다.
- 패킷 손실은 발생기 WebRTC 소스가 보고한 RTP 손실 수이고, 손실률은 RTP 패킷당 약 1,150 B로 추정한 값(`lossRatioEst`)이다.
- 같은 PC의 루프백·사설망 결과는 인터넷 1,000명 검증이 아니다. 실제 외부망·모바일 망 시험은 별도로 기록해야 한다.
- 작은 단계 결과를 선형 외삽해 1,000명 통과로 보고하지 않는다(보정의 `estimate`는 발생기 용량 계획용 추정치로만 표시된다).
