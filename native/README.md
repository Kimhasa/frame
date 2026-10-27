# FRAME Console 네이티브 호스트

승인된 UI(0.5 기준: `reference-v05/`, `UI_V05_LOCK.json`; 빌드 결과 `outputs/index.html`, 작성 소스 `work/`)를 WebView2로 띄우고 실제 창·모니터 캡처, FFmpeg 인코딩, MediaMTX 송출, 내부망 방송 목록, 시청, 방송 전체 되감기(DVR), 채팅을 연결하는 C++17 Win32 프로그램입니다.

## 빌드 환경

| 항목 | 버전 |
| --- | --- |
| Visual Studio 2022 Build Tools | 17.14.37806.7 (MSVC 14.44.35207, x64) |
| Windows SDK | 10.0.26100.0 (C++/WinRT 헤더 포함) |
| CMake / Ninja | Build Tools에 포함된 버전 |
| Node.js | 22 이상 (UI 빌드, 패키징, 검증 스크립트) |
| WebView2 SDK | 1.0.4314.35 (정적 로더 `WebView2LoaderStatic.lib`) |

Build Tools 설치 구성요소는 `deps/manifest.json`의 `toolchain`에 적혀 있습니다(`deps/toolchain/vs_BuildTools.exe`).

## 빌드 명령

프로젝트 루트(`frame/`)에서:

```bat
node tools\verify-ui-v05.mjs
node tools\fetch-deps.mjs
node work\build-console.mjs
node tools\verify-ui-v05.mjs
build\vsbuild.cmd
node tools\package-dist.mjs
```

- `verify-ui-v05.mjs`는 0.5 UI 잠금(템플릿, CSS, 컴포넌트, 마크업 해시, 금지 요소, 외부 의존 없음)과 0.4 원본(`reference/`, `UI_LOCK.json`) 보존을 함께 확인합니다. 기능 연결 JS(`work/console-ux.js`, `work/console-ui.js`의 데이터 연결)는 잠금 대상이 아닙니다.
- `fetch-deps.mjs`는 `deps/archives`의 보관본을 SHA-256으로 확인하고 `build/third_party`에 풉니다. 보관본이 있으면 인터넷 없이 동작합니다.
- `build\vsbuild.cmd`는 `vcvars64.bat`를 불러 `build/native`에 CMake(Ninja, Release)로 빌드합니다. `/W4` 경고 0개.
- `package-dist.mjs`는 `dist/FrameConsole`과 `dist/FrameConsole-0.5.0-win64.zip`을 만듭니다. 실행 진입점은 `dist/FrameConsole/FrameConsole.exe` 하나입니다. 실행 중인 exe가 있으면 먼저 종료하세요.

CRT는 정적으로 링크(`/MT`)해 실행 PC에 Visual C++ 재배포 패키지가 필요 없습니다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `src/main.cpp` | 창, WebView2(가상 호스트 `http://frame-console.example/`), 메시지 검증과 명령 처리, 미리보기 전달, 시청 서버·목록·채팅 시작 |
| `src/capture.*` | Windows Graphics Capture 창·모니터 캡처, 창은 클라이언트 영역만(DWM 프레임 범위 대비 클라이언트 좌표, 앱이 그린 제목 표시줄은 WM_NCHITTEST로 판별, DPI 가상화 창은 경계 1px 제외), D3D11 비디오 프로세서로 NV12/BGRA 변환, 창·모니터 목록(장치 경로 기반 고정 ID, 왼쪽부터 번호)과 썸네일, JPEG |
| `src/streamer.*` | MediaMTX 설정 생성과 실행(녹화·재생 서버 포함), FFmpeg 실행과 인코더 대체, 고정 프레임 펌프, 이름 있는 파이프, 측정값과 경고, 목록 썸네일, DVR 색인과 구간 요청, 송출 중 절전 방지(power request) |
| `src/recorder.*` | 녹화 폴더(`%LOCALAPPDATA%\FrameConsole\recordings\<방송ID>`), `broadcast.json`, 보관 기간·용량 상한 정리(이 프로그램의 방송 폴더만), 여유 공간 감시(녹화만 멈춤/재개), 분할 파일 시작 시각 |
| `src/directory.*` | 방송 목록: UDP 멀티캐스트(239.255.42.99:8899) 알림 송수신, 선택적 HTTP 알림(`directoryServers`), 7초 만료, 보낸 주소 검증 |
| `src/chat.*` | RFC 6455 WebSocket 채팅: 방송별 방, 이름 정규화·중복(다른 PC 간)·예약어 검사, 메시지 길이·속도 제한, 최근 기록 |
| `src/audio.*` | WASAPI 루프백(프로세스 제외 루프백 우선)과 마이크, 48 kHz 스테레오 변환, 실시간 음량 혼합 |
| `src/http_server.*` | 시청 포트(아래 경로), 연결 수 제한 |
| `src/http_client.*` | WinHTTP: MediaMTX API·WHEP·재생 서버 요청, 큰 응답 스트리밍, 다른 PC로의 목록 알림 |
| `src/child_process.*` | Job Object(KILL_ON_JOB_CLOSE)에 묶인 자식 프로세스, 출력 수집 |
| `src/config.*` | `config/frame-console.json`, 입력값 검증, 자동 비트레이트, 로컬 IP 확인 |

시청 포트(기본 8889)의 경로:

| 경로 | 내용 |
| --- | --- |
| `/`, `/<스트림>` | 승인된 UI(수신 화면, 목록) |
| `/api/broadcasts` | 이 PC가 아는 방송 목록(자기 방송 + 알림으로 받은 방송) |
| `/api/broadcasts/announce` | 다른 FRAME PC의 HTTP 알림(POST, 4 KB 이하, 보낸 주소 = 광고 주소일 때만) |
| `/thumbnails/<방송ID>.jpg` | 현재 방송의 목록용 썸네일(5초마다 갱신) |
| `/<스트림>/info` | 읽기 전용 방송 정보(크기, fps, 상한 비트레이트, 방송 ID, 화질 목록, DVR 여부) |
| `/<스트림>[/<화질>]/whep` | WebRTC 재생 요청 전달 |
| `/<스트림>/dvr` | 녹화 구간 색인 |
| `/<스트림>/dvr/media` | 녹화 fMP4 구간(최대 30초, chunked) |
| `/<스트림>/chat` | 채팅 WebSocket |

### 데이터 흐름

```
선택한 창/모니터 --WGC--> 클라이언트 영역만 복사 --비디오 프로세서(선택 해상도 안에 비율 유지·가운데 배치, BT.709 NV12)--> 고정 프레임 펌프
  --\\.\pipe\...-video (rawvideo nv12)--> ffmpeg (h264_nvenc/qsv/amf/libx264, B-프레임 없음, 1초 GOP)
시스템 소리/마이크 --WASAPI--> 48 kHz 혼합 --\\.\pipe\...-audio (WAV s16le, 10 ms 패킷)--> ffmpeg (Opus)
ffmpeg --RTSP 127.0.0.1:8554--> MediaMTX --WebRTC(UDP/TCP 8189)--> 시청 브라우저
                                MediaMTX --record(fMP4, 재인코딩 없음)--> 녹화 폴더
시청 브라우저 --HTTP 8889 (FrameConsole.exe)--> MediaMTX(127.0.0.1 전용 포트: WebRTC HTTP, API, playback)
```

- 영상 타임스탬프는 프레임 수 기준(고정 프레임)이며, 음성은 같은 시점에 시작합니다. 인코더가 늦어 프레임을 건너뛰면 같은 길이의 음성도 버려 동기화를 유지합니다.
- 낮은 재생 화질(`/<스트림>/720p` 등)은 MediaMTX `runOnDemand`가 같은 FFmpeg로 시청 중일 때만 다시 인코딩합니다. 녹화하지 않습니다.
- 출력 해상도는 선택한 화질 그대로이며 송출 중 바뀌지 않습니다(시청자·녹화가 한 규격 유지). 원본 비율이 다르면 여백은 인코더 한 곳에서만 들어가고, 짝수 반올림 때문에 생길 1~2px 검은 줄은 만들지 않습니다(FitRect).
- 자동 비트레이트: 0.07 bit/픽셀 × 60 × (fps/60)^0.75 × 인코더 계수(libx264 0.85), 0.5~200 Mbps. 기본 VBR(NVENC `-rc vbr -cq 23 -maxrate`, x264 `-crf 23 -maxrate`)에서 이 값은 상한입니다.

### 방송 전체 되감기(DVR)

```
MediaMTX --record--> <recordRoot>/<방송ID>/<스트림>/YYYY-MM-DD_HH-MM-SS-ffffff+zzzz.mp4  (1 s part, 60 s segment)
브라우저 --GET /<스트림>/dvr--> FrameConsole.exe --/list (1초 캐시, 모든 시청자 공유)--> MediaMTX playback
  {id, recording, ranges:[{startMs,endMs}], segments:[분할 파일 시작 ms], gopMs:1000, nowMs}
브라우저 --GET /<스트림>/dvr/media?id=<방송ID>&start=<ms>&duration=<ms>--> FrameConsole.exe --/get--> MediaMTX playback
  요청 시각부터 표시되는 fMP4 조각 | 404 아직 없음/녹화 빈 구간 | 409 다른 방송 | 업스트림 중단 시 종료 청크 없이 끊음
```

- MediaMTX는 녹화 루트를 작업 폴더로 실행하고 `recordPath`는 상대 경로(`./<방송ID>/%path/...%z`)라 사용자 경로의 공백·한글·%와 무관합니다.
- 브라우저(`work/console-ux.js`의 DVR 부분)는 MediaSource에 몇 초 단위 조각을 이어 붙입니다. 조각 시작은 분할 파일 시작 시각 + 1초(GOP) 격자에 맞춰 디코딩 낭비를 줄이고, 앞쪽 약 60 MB·뒤쪽 30 MB(방송 상한 비트레이트 기준)만 둡니다. 새 탐색·실시간 복귀·화질 변경은 진행 중인 탐색을 취소합니다.
- 지난 구간 재생 중에는 WHEP 세션을 닫습니다(소리 한 개). "실시간"은 WHEP를 다시 열고 첫 프레임이 나온 뒤 교체합니다.
- 시간축은 송출 PC의 시계(epoch ms)이며 UI 계약 `FrameUI.setTimeline({startMs,endMs,positionMs,mode})`, `frame:seek`, `frame:live`로 연결됩니다.

### 보안 경계

- WebView2 메시지는 `http://frame-console.example/`에서 온 것만 받고 명령 이름과 인수를 검사합니다. 다른 주소로의 이동과 새 창은 막습니다.
- 시청 포트에는 UI 파일, 목록·썸네일, 읽기 전용 정보, WHEP 전달, 현재 방송 ID로 제한된 DVR 구간 읽기, 채팅만 있습니다. 송출 시작/중지, 설정, 임의 파일 접근 경로는 없습니다. DVR 요청은 경로·방송 ID·시각·길이(최대 30초)를 검사한 뒤 재생 서버로 전달합니다.
- MediaMTX의 RTSP, API, WebRTC HTTP, playback은 127.0.0.1에만 열고, publish·API·playback 권한은 로컬 주소만 갖습니다.
- 목록 알림은 보낸 주소와 광고한 주소가 같을 때만 받습니다. 채팅 메시지와 이름은 서버가 정규화·검증하고 UI는 글자로만 표시합니다.
- 자식 프로세스는 이 프로그램의 Job Object에만 속하며 이름으로 다른 ffmpeg/mediamtx를 종료하지 않습니다.

## 개발용 확인

`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 환경 변수와 `--client-size=1440x1000` 인수로 실행하면 `tools/*.mjs` 검증 스크립트가 실제 앱 화면을 조작하고 캡처할 수 있습니다. 배포 실행에는 필요 없습니다.
UI 검사: 0.5.1 추가 지시(플레이어 조작부 자동 숨김)는 `work/player-ui.css` 한 파일로만 들어가며 `node tools/verify-ui-v051.mjs`가 0.5 잠금 그대로 + 이 파일만 차이임을 확인합니다(`UI_V051_ADDENDUM.json`). `verify-ui-v05.mjs`는 이 허용된 차이 때문에 마크업 해시 불일치를 보고합니다.
주요 스크립트: `test-crop.mjs`, `check-edges.mjs`, `save-frames.mjs`, `edge-window.ps1`, `window-control.ps1`(제목 표시줄 제외), `test-autohide.mjs`(자동 숨김), `smoke-v05.mjs`(목록·재생·채팅), `smoke-dvr.mjs`, `stress-dvr.mjs`, `measure-dvr.mjs`(되감기 위치 정확도), `test-dvr-restart.mjs`, `test-record-pause.mjs`(디스크 부족), `measure-storage.mjs`(크기·부하), `test-chat.mjs`, `capture-v05-states.mjs` + `compare-screens.mjs`(기준 화면 비교), `long-dvr.mjs`(장시간).
