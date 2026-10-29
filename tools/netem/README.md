# tools/netem — WebRTC 실제 미디어 경로 네트워크 제한과 자동 화질(ABR) 시험

Windows에는 tc/netem이 없고 DevTools의 네트워크 제한은 WebRTC UDP에 적용되지 않습니다. 이 폴더의 도구는 시청 브라우저와 송출 PC의 WebRTC ICE UDP 포트(앱 기본 8189) 사이에 사용자 공간 UDP 중계를 두고, 그 중계에서 대역폭·지연·지터·손실·끊김을 시간표대로 바꿉니다. 제품 코드는 바꾸지 않습니다. 시험용 브라우저 페이지에만 CDP로 스크립트를 주입해 서버 ICE 후보를 중계 주소로 바꿉니다.

```
Edge(시청 페이지) ──UDP──▶ 127.0.0.1:<중계> udp-proxy.mjs ──UDP──▶ <송출 PC>:8189 (MediaMTX ICE)
                ◀── down: 대역폭+드롭테일 큐 → 지연+지터 → 손실/끊김 ◀──
```

- 브라우저 소켓마다 별도 상위 소켓을 만들어 서버에는 일반 peer-reflexive 후보로 보입니다. 브라우저 getStats의 로컬 후보(prflx)가 이 상위 소켓이라 연결별로 중계 카운터와 맞춰 볼 수 있습니다.
- 한 시청 PC의 접속 회선을 흉내 내므로 모든 소켓이 같은 down/up 링크를 공유합니다. 화질 전환 중 두 연결이 겹치면 같은 회선을 나눠 씁니다.
- Node 24만 필요하며 npm 의존성은 없습니다.

## 파일

| 파일 | 내용 |
| --- | --- |
| `link.mjs` | 한 방향 링크 모델: 끊김 → 무작위/버스트 손실(Gilbert) → 대역폭 병목(드롭테일 큐) → 고정 지연+지터 |
| `profile.mjs` | 프로필 JSON 읽기·검증(`repeat` 블록, `--time-scale`, `--rate-scale`) |
| `udp-proxy.mjs` | UDP 중계와 시간표, 1초 JSONL 카운터, 소켓(연결)별 바이트. CLI와 `startProxy()` 모듈 |
| `attach.mjs` | CDP 주입: answer SDP·PATCH 응답 후보 재작성, offer·PATCH의 브라우저 후보 제거, **모든** RTCPeerConnection getStats 기록기, FRAME 기본 probe |
| `run-viewer.mjs` | 실제 FRAME 시청 페이지(또는 `--fixture`)에 프로필을 적용하고 자동 화질 결과까지 요약 |
| `fixtures/frame-fixture.mjs` | 앱 없이 시험하는 대역: 자체 MediaMTX(원본 + 요청 시 720p·480p), FFmpeg testsrc2, `outputs/index.html`과 `/<path>/info`·WHEP 중계를 주는 작은 시청 서버 |
| `run-verify.mjs` | 독립 MediaMTX + FFmpeg testsrc2 1080p60 + 최소 WHEP 페이지로 실제 미디어 경로 검증 |
| `selftest.mjs` | 브라우저 없이 합성 UDP로 대역폭(양방향)·지연·지터(두 방식)·손실 정확도 확인. 기준 미달 시 종료 코드 1 |
| `summarize.mjs` | `proxy.jsonl` + `stats.jsonl`에서 단계별 요약, 끊김 회복, 연결 교차 확인, 자동 화질 요약(`abr.csv`) |
| `harness.mjs` | 실행기 공통 부분: 프로세스 PID 관리, Edge 실행, CPU 기록 |
| `whep-viewer.html` | 앱의 `openSession`과 같은 방식으로 협상하는 최소 WHEP 시험 페이지 |
| `profiles/*.json` | 경로 검증용 `steps`, `loss-jitter`, `outage`, `boundary` / 자동 화질용 `abr-steps`, `abr-loss-jitter`, `abr-outage`, `abr-boundary` |

## 실제 앱 자동 화질 시험 (리드가 조용한 PC에서 실행)

시청 PC에서 실행합니다. 송출 PC 쪽은 아무것도 바꾸지 않습니다.

```bat
node tools\netem\run-viewer.mjs --url http://<sender-ip>:8889/<path> --profile abr-steps
```

- `--target`을 주지 않으면 `<URL 호스트>:8189`입니다(앱은 모든 화질 경로가 ICE UDP 8189 하나를 씁니다). 호스트 이름도 됩니다. 시작할 때 한 번 IPv4로 풀어 그 주소와 비교합니다.
- 기본 창은 headless `1600,1000`, `--dpr 2`입니다. 앱은 화면에 보이는 높이보다 큰 화질을 받지 않으므로(`표시 크기` 규칙) 장치 픽셀이 부족하면 네트워크가 아니라 크기 규칙을 시험하게 됩니다. 이 설정에서 화면 높이는 약 1139 px로 1080p가 상한입니다. `abr.shownHeight`에 기록됩니다.
- 기본 probe(`--probe frame`)는 1초마다 `FrameRuntime.abr`(mode, playing, holdUpMs, decisions, last)와 `FrameRuntime.video`의 디코딩 크기·화면 높이·프레임 수, `/info`의 화질 사다리를 기록합니다. `--probe none`으로 끄거나 JS 식을 직접 줄 수 있습니다.
- 기본 포트는 중계 127.0.0.1:22301, DevTools 22223이고, `--fixture` 실행은 여기에 fixture 포트 22600~22603(시청 서버, ICE UDP·TCP, MediaMTX WHEP, RTSP)을 더 씁니다. 두 실행을 같이 돌리려면 `--proxy-port`, `--devtools`를 바꾸고, `--fixture` 실행이면 `--fixture-port`도 4개 번호가 겹치지 않게 바꿉니다. `run-verify.mjs`는 `--base-port`로 7개 포트를 한꺼번에 옮깁니다. (두 실행을 실제로 동시에 돌려 본 적은 없습니다. 포트가 겹치지 않는 것만 코드로 확인했습니다.)
- 실행이 중간에 강제 종료되면(예: PC가 느려져 멈춘 경우) `%TEMP%\frame-netem-*` 작업 폴더(Edge 프로필)가 남습니다. 다음 실행이 시작할 때, 이름의 PID가 이미 끝난 폴더를 지웁니다. 아직 쓰는 중인 폴더는 남겨 둡니다. `selftest.mjs`도 같은 방식으로 `netem-selftest-<PID>.json(l)`를 지우고, 실패하거나 예외로 끝나도 자기 임시 파일을 지우고 중계를 종료합니다.
- 결과: `verification/netem/viewer-<profile>-<시각>/`에 `summary.json`(`steps`, `outages`, `crossCheck`, `abr`), `summary.csv`, `abr.csv`, `stats.jsonl`, `proxy.jsonl`, `host.jsonl`, `meta.json`, `logs/`가 생깁니다. 같은 폴더에 두 번 실행하면 섞이므로 거부합니다.
- 다른 옵션: `--headed`, `--size`, `--warmup 15`, `--click <선택자>`, `--server <ip 또는 이름>`(그 주소의 후보만 사용, 이름은 한 번 IPv4로 풂), `--rate-scale`, `--time-scale`(자동 화질 판단 시간은 줄지 않으므로 ABR 시험에는 쓰지 않음), `--edge-args "--disable-accelerated-video-decode"`(디코딩 한계 ABR-11).

앱 없이 같은 시험(대역 fixture):

```bat
node tools\netem\run-viewer.mjs --fixture --fixture-port 22600 --proxy-port 22610 --devtools 22611 --profile abr-steps --out verification\netem\abr-fixture-steps
```

fixture는 앱의 시청 서버가 하는 일(페이지, `/<path>/info`, `/<path>/whep`와 `/<path>/<h>p/whep` 중계, `Location`을 같은 origin으로 유지, DELETE/PATCH 전달, `/stats` 비콘)을 한 스트림에 대해 그대로 합니다. MediaMTX 설정은 `native/src/streamer.cpp`가 만드는 것과 같은 WebRTC 구성(ICE UDP·TCP 같은 번호 하나, 모든 인터페이스 후보, `runOnDemand` 렌디션, `runOnDemandCloseAfter 30s`)입니다. 원본은 testsrc2 1920x1080 60fps h264_nvenc **CBR** 8M + Opus 128k, 렌디션은 1280x720 4M / 854x480 1.5M입니다(`--rate-control vbr`로 앱 기본과 같은 VBR cq 23도 가능). WHEP 요청은 `whep.jsonl`, 페이지 비콘은 `beacons.jsonl`에 남습니다.

## 자동 화질 요약 (`summary.json` → `abr`, `abr.csv`)

- `ladder`: 페이지가 받은 화질 사다리와 각 화질이 회선에서 필요한 양(`need = mbps × 1.07 + 0.2`: RTP·UDP·IP 헤더, 재전송, Opus. 측정값 8M CBR + Opus = UDP 8.35 Mbps, 중계 헤더 포함 8.54 Mbps).
- `steps[]`(단계마다):
  - `bestFit`: 그 회선 속도에 맞는 가장 높은 화질(없으면 `none`)
  - `playingAtStart/End`, `playedSec`(화질별 재생 초), `decodedSec`(실제 디코딩 높이별 초)
  - `drop`: 재생 중 화질이 회선보다 클 때만. `firstDownDecisionSec`(단계 시작→첫 하향 결정), `firstDownPlayingSec`(→새 화질 첫 프레임, 전환 완료), `fitPlayingSec`(→맞는 화질 재생, 아무것도 맞지 않으면 최저 화질)
  - `upHolds[]`: 상향마다 단계 시작 후 시각, 직전 전환 후 경과(`sinceLastSwitchSec`), 그때의 `holdUpMs`, 60초 안에 되돌려졌는지(`undoneWithinSec`)
  - `switches/downs/ups/failedStarts`, `freezes`, `freezeSec`(freeze+pause), `zeroFpsSec`, `pictureStalledSec`(화면 video 요소의 프레임 수가 늘지 않은 초). Chrome은 freeze·pause 길이를 **다음 프레임이 올 때** 한꺼번에 더하므로, 여러 단계에 걸친 정지는 회복한 단계의 `freezeSec`에 몰립니다. 단계별로 화면이 멈춘 시간은 `pictureStalledSec`·`zeroFpsSec`를 봅니다.
- `decisions[]`: 페이지 결정마다 시작 시각(`at − ms`), 단계, 이유 분류(`freeze/loss/jitter/fps` 네트워크, `decode` 기기, `size` 표시 크기, `stable` 상향), 전환 시간, 직전 5초 중계 상태(드롭 수, 큐 최대, 끊김), 그리고 표시:
  - `down-without-network-or-size-reason`: 네트워크·크기·디코딩 이유 없이 내린 경우
  - `network-reason-but-line-unimpaired`: 네트워크 이유로 내렸지만 직전 5초 중계에 드롭·큐 50 ms 이상·끊김·손실 설정이 없었던 경우
  - `up-without-stable-reason`
- `totals`: 결정·전환·하향·상향 수, `reversals`(방향이 바뀐 전환), `failedUpProbes`(상향 후 20초 안에 하향), `holdUpMsValues`, 위 표시별 개수, `playingChangesWithoutDecision`(결정 기록 없이 바뀐 재생 화질, 예: 재연결), 그리고 연결 기준 전환 시도 수(아래 `attempts`): `switchAttempts`, `attemptsShown`, `attemptsNotShown`, `attemptsStuckOver15s`(아래 `stuck`; 그중 나중에 화면에 오른 것 `attemptsStuckThenShown`, 닫힌 것 `attemptsStuckClosed`, 끝까지 열린 것 `attemptsStuckOpenAtEnd`), `attemptsWithoutDecision`, `attemptsHangingAtEnd`, `maxSwitchPendingSec`, `maxPendingPlaySec`(라이브 스트림 `video.play()`가 끝나지 않고 기다린 최장 시간)
  - 같은 단계 안에서 60초 안에 방향이 바뀐 전환 쌍(`reversalsWithin60s[]`)을 셋으로 나눕니다.
    - `oscillations`: 첫 전환이 떠난 화질로 돌아가거나 그 너머로 간 경우(720p→1080p→720p, 720p→480p→720p). 진짜 왕복입니다.
    - `overshootCorrections`: 두 화질 사이에서 멈춘 경우(1080p→480p→720p). 너무 깊이 내린 뒤의 정상 회복이며 왕복이 아닙니다.
    - `reversalsAfterPreviousStep`: 단계 시작 5초 안의 하향인데, 이 단계 회선은 떠난 화질을 감당하고 직전 단계(끊김, 더 좁은 대역, 손실, 지터)는 감당하지 못한 경우. 직전 단계에 대한 반응과 그 뒤 복귀입니다(끊김 뒤 1080p→720p→1080p).
- `attempts[]`: 첫 연결 뒤에 페이지가 연 연결마다(=전환 시도) 요청한 화질(WHEP 경로 `/<path>/<h>p/whep`), 만든 시각과 단계, 첫 디코딩 프레임(`firstFrameSec`)·화면 교체(`shownSec`)·닫힘(`closedSec`)까지 걸린 초, 화면에 오르지 못한 채 열려 있던 시간(`pendingSec`), 결과(`shown`, `closed-without-frames`, `open-without-frames-at-end` 등), 그리고 맞는 결정(`decision`, 없으면 null). 페이지는 전환이 끝나거나 실패해야 결정을 기록하므로, 걸린 전환은 결정 기록에 나타나지 않고 이 목록에만 나타납니다.
  - `stuck`: 15초 이상 화면에 오르지 못한 시도입니다. 나중에 화면에 올랐어도 해당합니다. `stuckKind`가 `shown-late`(늦게 오름), `closed-not-shown`(오르지 못하고 닫힘), `open-at-end`(끝까지 열림) 중 무엇인지 알려 줍니다. 220초 걸렸다가 화면에 오른 전환도 `stuck`입니다.
- 단계 행의 `attempts`(그 단계에서 시작한 시도, `stuck`이면 `!STUCK`), `attemptsStuck`(`abr.csv`의 `attempts_stuck`), `switchInProgressSec`(새 연결이 화면에 오르기 전 두 연결이 회선을 나눠 쓴 초)
- 요약 최상위 `connections[]`는 첫 연결까지 포함한 같은 연결 목록입니다(probe 없이도 생성).

## 주입 내용 (`attach.mjs`, 시험 페이지에만 적용)

1. `setRemoteDescription`: 원격 SDP에서 UDP host 후보만 남기고 주소:포트를 중계 주소로 바꿉니다. 컴포넌트별로 하나만 남기며 TCP·srflx·relay 후보는 버립니다. `--server <ip>`를 주면 그 주소의 후보만 사용합니다. `addIceCandidate`도 같은 규칙을 따릅니다.
2. `fetch`: WHEP offer(`application/sdp` POST)에서 브라우저 후보를 지웁니다. trickle·ICE restart PATCH(`application/trickle-ice-sdpfrag`)는 **서버로 그대로 보내되** 브라우저 후보 줄만 지우고, 응답이 sdpfrag이면 그 안의 서버 후보도 중계 주소로 바꿉니다(`patches[]`에 상태 코드 기록). `--keep-local-candidates`로 후보 제거를 끕니다.
   - 헤더는 일반 객체, `[이름, 값]` 배열, `Headers` 모두 읽습니다. `fetch(new Request(...))`처럼 Request 객체로 보내도 본문을 읽어 같은 요청으로 다시 보냅니다. 본문은 문자열, Blob, ArrayBuffer를 처리하고 스트림은 건드리지 않습니다.
   - PATCH 전달은 Node에서 페이지 스크립트를 돌린 시뮬레이션으로만 확인했습니다. 실제 브라우저의 ICE restart로는 확인하지 않았습니다. FRAME 페이지는 PATCH를 보내지 않습니다.
3. `iceServers`를 비웁니다(STUN/TURN 후보는 중계를 지나지 않음). `--keep-ice-servers`로 끕니다.
4. 페이지가 만든 연결을 모두 보관하고 `window.__netem.sample()`이 열린 연결 전부와 그 사이에 닫힌 연결의 마지막 기록을 돌려줍니다. 연결마다 WHEP POST 경로(offer SDP가 그 연결의 local description과 같은 요청), 응답 코드와 시간, 첫 디코딩 프레임·화면 교체 시각(표본 간격 해상도)도 붙입니다. 최상위 필드는 화면 video 요소에 트랙이 붙은 연결입니다. Chrome은 `close()` 뒤 후보 쌍 통계를 지우므로, 닫힌 연결의 마지막 쌍 바이트는 직전 표본 값을 RTP 카운터 증가 비율로 늘려 추정합니다(`estimated`, `crossCheck.estimatedBytesOfClosedConnections`).

`stats.jsonl` 한 줄: `conns[]`(연결별 getStats와 `rate`), `rate`(화면 연결), `sum`(모든 연결 합: 바이트, 손실, 수신 패킷, freeze, NACK, PLI), `probe`. 카운터 변화량은 음수도 그대로 둡니다(늦게 온 패킷·재전송이 `packetsLost`를 줄임). 새 연결의 첫 표본은 0부터 셉니다.

## 프로필 형식

```json
{ "name": "steps", "description": "...", "loop": false,
  "defaults": { "both": {}, "down": { "rateMbps": 15, "maxQueueMs": 250, "delayMs": 20 }, "up": { "delayMs": 20 } },
  "steps": [ { "label": "8M", "duration": 25, "down": { "rateMbps": 8 } },
             { "repeat": 10, "steps": [ ... ] },
             { "label": "cut", "duration": 2, "outage": true } ] }
```

각 단계는 `defaults`와 그 단계 설정을 합친 값이며 이전 단계를 이어받지 않습니다. `--time-scale`이 1이 아니면 단계 이름 뒤에 실제 길이가 붙습니다(예: `cut-10s[3s]`). 프로필이 끝나면(`profile-end`) 중계는 `defaults`로 돌아가고 `config` 이벤트(`reason: "profile-end"`)를 남깁니다. 그래서 마지막 단계가 끊김이어도 선언한 길이만큼만 끊깁니다.

- `rateMbps`: `null`이면 무제한. 패킷마다 IPv4+UDP 28바이트를 더해 계산합니다.
- `maxQueueMs`: 드롭테일 버퍼를 현재 속도 기준 대기 시간으로 정합니다.
- `delayMs`, `jitterMs`, `jitterMode`: `smooth`는 큐처럼 지연이 서서히 변하고 순서를 유지, `packet`은 패킷마다 독립(순서 바뀜).
- `lossPct`, `lossBurst`: `lossBurst` 1은 독립 손실, 1보다 크면 Gilbert 모델 평균 연속 손실. 모델 한계상 `lossPct/100 ≤ lossBurst/(1+lossBurst)`여야 하며 넘으면 설정을 거부합니다. `lossPct` 100(`lossBurst` 1)은 모든 패킷을 버립니다.
- `outage`: 해당 방향 패킷을 모두 버립니다.

자동 화질용 프로필은 앱의 판단 창(하향 3초 창·3초 간격, 상향 12초 안정 + 상향 대기 12초, 실패 시 2배·최대 120초)보다 길게 잡았습니다.

| 프로필 | 내용 | 길이 |
| --- | --- | --- |
| `abr-steps` | 15→8→3→1→0.5→8→15 Mbps, 40/50/50/45/45/60/90초 | 380초 |
| `abr-loss-jitter` | 30 Mbps에서 손실 0.5·2·5%, 버스트 5%/3 + 지터 30, 패킷 지터 20, 지연 150 ms, 사이 정상 구간 | 460초 |
| `abr-outage` | 30 Mbps에서 끊김 1·3·6·12초, 회복 45~60초 | 272초 |
| `abr-boundary` | 6 Mbps 150초(720p만 맞음, 1080p 상향 실패 반복) → 7↔11 Mbps 20초 × 4 → 15 Mbps | 410초 |

## 출력 (`proxy.jsonl`)

`ready`(풀린 대상 주소 포함), `config`(단계 전환), 1초 `tick`, `session`, `totals`(`perSession`: 소켓별 서버 송신·중계 전달 바이트). `tick`의 방향별 값: `rxMbps`(서버가 보낸 양), `txMbps`(통과한 양), 원인별 드롭(`dropQueue`, `dropLoss`, `dropOutage`), `queueMsAvg/Max/Now`, `delayMsAvg/Max`, `lateMsMax`. 요약의 드롭 비율은 이 드롭 카운터를 받은 패킷 수로 나눈 값입니다(`lossDropPct`, `queueDropPct`, `outageDropPct`, `dropPct`).

## 검증 결과 (2026-10-28, 같은 PC 루프백)

모두 이 PC 한 대(i7-11800H 16스레드, 16 GB)의 루프백에서 측정했습니다. 인터넷, 서로 다른 PC, 동시 시청자 수에 대한 결과가 아닙니다. Edge 156.0.4314.42 headless, MediaMTX v1.21.3, FFmpeg 9.0.2(h264_nvenc CBR)를 썼고, 같은 PC에서 다른 프로그램(게임 포함)이 함께 돌았습니다.

- **`selftest.mjs`** (`selftest-spin.json`, 이번 수정 뒤 다시 실행): spin 18/18 통과, 종료 코드 0. lossPct 100 모델 검사를 추가했습니다.
  - PC 전체 CPU 18.5%, 중계 CPU 코어 1개의 62.6%, 늦게 내보낸 최대 0.5 ms
  - 5M 제한/10M 입력에서 4.89 Mbps(기대 4.89), 큐 지연 p50 198.0 ms. 상향 2M 제한에서 1.922 Mbps(기대 1.918), p50 196.8 ms. 패킷 지터 모드에서 순서 바뀜 952개.
  - 실패 경로: 가짜 서버 포트(22841)나 중계 포트(22850)를 미리 점유하고 실행하면 1초 안에 종료 코드 1로 끝납니다. 임시 파일과 22000~22999 수신 포트는 남지 않았습니다.
  - coarse(`selftest-coarse.json`)는 이전 코드로 돌린 17/17 결과이며 이번에는 다시 돌리지 않았습니다. 늦게 내보낸 최대 시간은 그 실행에서 15 ms, 이전 검증에서 19.7 ms였습니다.
- **`run-verify`** (`steps`·`outage`·`loss-jitter`·`boundary` 폴더, 이전 실행): 교차 확인 비율 0.9999, 다른 후보 쌍 수신 0입니다. `steps`는 `--target-host localhost --base-port 22100`으로 돌렸습니다. 실행 중 PC 전체 CPU는 평균 16~25%, 최대 47%였습니다.
  - `loss-jitter`: 손실 설정 0.5/2/5(버스트 3)/10%에 대해 중계 손실 카운터는 0.54/1.93/4.90/10.20%였습니다.
  - `boundary` 서버 송신량은 계산 창에 따라 범위가 달라집니다.
    - `summary.json` 단계 행(정착 3초 뒤): 10M 구간 24.4~34.6 Mbps, 7.5M 구간 35.0~38.9 Mbps
    - 단계 전체 tick 평균: 10M 28.0~32.8 Mbps, 7.5M 23.3~37.6 Mbps. 23.3은 15M에서 넘어온 첫 7.5M 구간입니다.
- **`outage-short-after-fix`** (이번 수정 뒤, `--time-scale 0.3 --base-port 22100 --target-host localhost`): 바뀐 fetch 가로채기가 실제 Edge에서 동작하는지 확인했습니다.
  - WHEP offer 후보 제거 1회, 연결별 WHEP 경로 기록(`/test/whep`, 201, 133 ms), 교차 확인 0.9999, 중계 후보 표본 100%, 다른 후보 쌍 0바이트
  - 프로필이 끝난 뒤 `profile-end` 다음에 `config`(`reason: "profile-end"`, 30 Mbps 기본값)가 기록됐습니다.
  - 끊김 0.15/0.6/1.5/3초 뒤 영상 복귀 0.4/0.9/1.4/1.5초, 모두 같은 연결
  - PC 전체 CPU 평균 23.6%, 최대 46.8%, 메모리 사용 최대 94.5%. 중계 CPU 코어 1개의 84.9%, 늦게 내보낸 최대 0.6 ms
- **fixture 자동 화질** (`abr-fixture-steps`, `abr-fixture-outage`, 실제 `outputs/index.html`): 수정한 요약기로 다시 요약했습니다(원본 기록은 그대로). `abr-fixture-steps` 실행 중 PC 전체 CPU는 평균 33.7%, 최대 79.4%였습니다.
  - `abr-fixture-steps`: 81.3초(8M 구간 +41.3초)에 시작한 720p→1080p 전환이 220.3초 동안 화면에 오르지 못했습니다(`stuck`, `shown-late`).
    - `attemptsStuckOver15s` 1, 8M 행 `attempts_stuck` 1
    - 그 연결의 `video.play()`는 81.6초에 호출되어 301.0초에 끝났습니다(219.4초). 그 연결의 첫 디코딩 프레임 표본은 301.7초입니다.
    - `oscillations` 0, `overshootCorrections` 2(8M과 15M-again의 1080p→480p→720p)
  - **서버 송신 증폭 10.28배는 일반 계수가 아닙니다.** 이 실행 전체에서 서버가 보낸 양은 2.53 GB, 중계가 전달한 양은 0.25 GB였습니다.
    - 대부분은 걸린 전환 220초 동안 열려 있던 연결 2(720p)와 3(1080p)의 서버 송신(1.09 GB, 1.28 GB)입니다.
    - 단계별로는 15M 1.00배, 8M 4.5배, 3M·1M·0.5M 32·105·222배(한 시청자에게 92~96 Mbps), 8M-again 10배, 15M-again 1.45배입니다.
    - 자동 화질이 정상으로 돈 `abr-fixture-outage` 전체는 1.09배입니다.
    - 따라서 1,000명 송신량 산정의 일반 계수로 쓸 수 없습니다. 회선보다 큰 스트림을 받는 시청자 한 명이 이만큼을 일으킬 수 있다는 근거일 뿐입니다.
  - `abr-fixture-outage`: 방향이 바뀐 전환 쌍 3개는 모두 `reversalsAfterPreviousStep`입니다(1·3·6초 끊김 직후 1080p→720p, 약 15초 뒤 1080p). `oscillations`는 0입니다.
    - 12초 끊김 중(끊김 시작 10.5초 뒤) 페이지가 자동 화질 결정 없이 새 세션(1080p)을 열었고, 2.9초 뒤 화면에 올랐습니다(`attemptsWithoutDecision` 1).
  - `abr-fixture-steps-interrupted`(사용자가 멈춘 실행)에는 `play()` 기록이 한 줄도 없습니다(`maxPendingPlaySec` null).
    - 102.5초는 화질을 알 수 없는(WHEP 경로 null) 연결이 기록이 끊길 때까지 프레임 없이 열려 있던 시간입니다(`stuck`, `open-at-end`). `play()` 대기 시간이 아닙니다.
  - `work/console-ux.js`의 화질 전환이 `await video.play()` 뒤에야 15초 제한을 시작한다는 원인은 위 데이터(`play()` 종료 301.0초 ≈ 첫 프레임 301.7초)와 코드로 뒷받침됩니다. 브라우저 단독 재현은 아직 없습니다.
  - `abr-loss-jitter`, `abr-boundary` 프로필은 돌리지 않았습니다. 형식 검증만 통과했습니다.

