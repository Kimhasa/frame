# FRAME Console 네이티브 호스트

승인된 UI(0.5 기준: `reference-v05/`, `UI_V05_LOCK.json`; 빌드 결과 `outputs/index.html`, 작성 소스 `work/`)를 WebView2로 띄우고 실제 창·모니터 캡처, FFmpeg 인코딩, MediaMTX 송출, 같은 네트워크 방송 목록, 인터넷 중계 서버로의 복사 송출, 시청, 방송 전체 되감기(DVR), 채팅을 연결하는 C++17 Win32 프로그램입니다.

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

## native/ 밖의 빌드 입력

송출 앱을 별도 저장소로 옮길 때 함께 가져가야 하는 입력입니다. 위치는 저장소 루트 기준입니다.

| 위치 | 역할 | 쓰는 곳 |
| --- | --- | --- |
| `deps/manifest.json` | 고정 버전과 SHA-256: FFmpeg 9.0.2, MediaMTX 1.21.3, WebView2 SDK 1.0.4314.35, nlohmann 3.12.0, hls.js 1.5.20, WebView2 Runtime 설치 파일, Build Tools 구성 | `tools/fetch-deps.mjs`, `tools/package-dist.mjs` |
| `deps/archives/` | 위 패키지의 보관본(저장소 밖으로 관리, `.gitignore`) | `fetch-deps.mjs` |
| `build/third_party/` | 보관본을 푼 곳(FFmpeg, MediaMTX, WebView2 SDK, hls.js) | `CMakeLists.txt`(`FRAME_THIRD_PARTY`), `package-dist.mjs` |
| `work/` | 콘솔·시청 UI 소스(CSS, JS, 템플릿) | `work/build-console.mjs` |
| `outputs/index.html`, `outputs/assets/` | 빌드된 UI, 글꼴, hls.js. 앱의 `ui/`로 들어가고, 중계 백엔드가 기존 `/<path>` 화면으로도 제공 | `package-dist.mjs`, `apps/api`의 `page/LegacyPageController`(`RELAY_UI_FILE`로 받은 경로만 읽음) |
| `UI_V05_LOCK.json`, `UI_LOCK.json`, `UI_V0*_ADDENDUM.json`, `reference/`, `reference-v05/` | UI 잠금 검사 기준 | `tools/verify-ui-*.mjs` |
| `packaging/` | 배포 README, 방화벽 스크립트, 설정 예시 | `package-dist.mjs` |
| `tools/` | 의존성 준비, 패키징, UI 검사, 검증 도구(`cdp.mjs` 등) | 빌드 명령 전체 |
| `build/vsbuild.cmd` | Visual Studio 2022 Build Tools 경로 고정 빌드 진입점. 빌드 폴더 `build/native` | 위 빌드 명령 |

실행 중 앱이 읽는 파일은 모두 exe 폴더 기준입니다: `bin/ffmpeg.exe`, `bin/mediamtx.exe`, `ui/`, `config/frame-console.json`, `config/frame-console.secrets.json`(중계 계정과 토큰, 저장소에 넣지 않음). 백엔드와는 `relayApiUrl`(HTTP)과 `relayPublishUrl`(RTSPS) 설정으로만 연결합니다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `src/main.cpp` | 창, WebView2(가상 호스트 `http://frame-console.example/`), 메시지 검증과 명령 처리, 미리보기 전달, 시청 서버·목록·채팅 시작 |
| `src/capture.*` | Windows Graphics Capture 창·모니터 캡처, 창은 클라이언트 영역만(DWM 프레임 범위 대비 클라이언트 좌표, 앱이 그린 제목 표시줄은 WM_NCHITTEST로 판별, DPI 가상화 창은 경계 1px 제외), D3D11 비디오 프로세서로 NV12/BGRA 변환, 창·모니터 목록(장치 경로 기반 고정 ID, 왼쪽부터 번호)과 썸네일, JPEG |
| `src/thumbnails.*` | "프로그램 창" 미리보기 작업자: 목록 세대·요청 ID, 보이는 카드·선택 창 우선, 동시 2개, 첫 프레임 이벤트 대기(1초)·시도 3회(재시도 250/750ms, 두 번째는 DWM 경로)·창별 기한 5초, 최소화된 창은 DWM 썸네일을 cloak된 도우미 창에 그려 캡처(모두 0이면 이미지 없음), 캡처 제외(표시 선호도) 창은 시도하지 않음, 닫힘·숨김·최소화·복원 감시(0.5초), 60초 캐시(이전 화면 표시), 시도별 진단 로그(`[thumb]`), 시험용 결함 주입(`FRAME_CONSOLE_THUMB_FAULT`) |
| `src/window_icon.*` | 선택창 제목 행의 앱 아이콘: WM_GETICON(SendMessageTimeout 100ms, 응답 없는 창은 즉시 포기) → 창 클래스 아이콘 → 창 아이콘이 표시 크기보다 작으면 실행 파일 아이콘(SHDefExtractIcon, ApplicationFrameHost 제외), WIC로 투명 PNG(표시 크기 × 배율), 창·프로세스·아이콘 핸들·크기별 캐시. 빌린 아이콘 핸들은 해제하지 않음 |
| `src/streamer.*` | MediaMTX 설정 생성과 실행(녹화용 복사 경로 `<스트림>/rec`·재생 서버 포함), FFmpeg 실행(H.264 + Opus + AAC)과 인코더 대체, HLS 다중 화질 재생 목록(`live.m3u8`), HLS DVR 재생 목록(`dvr.m3u8`), HLS 시청 세션 집계, 고정 프레임 펌프, 이름 있는 파이프, 측정값과 경고, 목록 썸네일, DVR 색인과 구간 요청, 송출 중 절전 방지(power request) |
| `src/recorder.*` | 녹화 폴더(`%LOCALAPPDATA%\FrameConsole\recordings\<방송ID>`), `broadcast.json`, 보관 기간·용량 상한 정리(이 프로그램의 방송 폴더만), 여유 공간 감시(녹화만 멈춤/재개), 분할 파일 시작 시각, HLS DVR용 fMP4 색인(완성된 moof+mdat만, 영상 키프레임 위치)과 키프레임에서 자른 세그먼트 생성 |
| `src/directory.*` | 방송 목록: UDP 멀티캐스트(239.255.42.99:8899) 알림 송수신, 선택적 HTTP 알림(`directoryServers`), 7초 만료, 보낸 주소 검증 |
| `src/chat.*` | RFC 6455 WebSocket 채팅: 방송별 방, 이름 정규화·중복(다른 PC 간)·예약어 검사, 메시지 길이·속도 제한, 최근 기록 |
| `src/audio.*` | WASAPI 루프백(프로세스 제외 루프백 우선)과 마이크, 48 kHz 스테레오 변환, 실시간 음량 혼합 |
| `src/http_server.*` | 시청 포트(아래 경로), 연결 수 제한, MediaMTX HLS 세션 공유(모든 시청자에게 같은 응답), 녹화 파일 Range 읽기 |
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
| `/<스트림>/info` | 읽기 전용 방송 정보(크기, fps, 상한 비트레이트, 방송 ID, 화질 목록, DVR 여부, `hls`: `{master:"live.m3u8", lowLatency:true, audio:"aac" 또는 "none", dvr:"dvr.m3u8" 또는 null}`) |
| `/assets/js/<파일>`, `/<스트림>/assets/js/<파일>` | UI가 쓰는 재생 스크립트(`ui\assets\js`, 예: `hls-1.5.20.min.js`). 이름에 버전이 있어 1년 캐시 |
| `/<스트림>/live.m3u8[?q=source 또는 720p 등]` | HLS 다중 화질 재생 목록(원본 먼저, 낮은 화질은 높은 순, 화질마다 AAC 오디오), `max-age=1` |
| `/<스트림>[/<화질>]/hls/<파일>` | MediaMTX LL-HLS 재생 목록(`video1_stream.m3u8`, `audio3_stream.m3u8`)과 init/part/segment 전달, 차단 갱신 쿼리(`_HLS_msn`, `_HLS_part`, `_HLS_skip`) 통과 |
| `/<스트림>/session`, `/<스트림>/session/<sid>` | HLS 시청 세션(POST 열기 → `{sid, heartbeatMs}`, PUT 15초마다, DELETE 떠남; 30초 안에 신호가 있으면 시청 중). 집계만 하며 이 서버에는 상한이 없음 |
| `/<스트림>[/<화질>]/whep` | WebRTC 재생 요청 전달(데스크톱 앱 수신, 부하 도구, HLS를 못 쓰는 브라우저) |
| `/<스트림>/dvr.m3u8` | 현재 방송 녹화의 HLS EVENT 재생 목록 |
| `/<스트림>/dvr/file?id=&f=[&s=]` | 녹화 파일: `s`가 없으면 파일 자체(Range 206, 목록에 나온 바이트까지만), `s`가 있으면 그 세그먼트 |
| `/<스트림>/dvr` | 녹화 구간 색인(이전 화면용으로 유지) |
| `/<스트림>/dvr/media` | 녹화 fMP4 구간(최대 30초, chunked, 이전 화면용; 녹화 트랙은 H.264 + AAC) |
| `/<스트림>/chat` | 채팅 WebSocket |

### 데이터 흐름

```
선택한 창/모니터 --WGC--> 클라이언트 영역만 복사 --비디오 프로세서(선택 해상도 안에 비율 유지·가운데 배치, BT.709 NV12)--> 고정 프레임 펌프
  --\\.\pipe\...-video (rawvideo nv12)--> ffmpeg (h264_nvenc/qsv/amf/libx264, B-프레임 없음, 1초 GOP)
시스템 소리/마이크 --WASAPI--> 48 kHz 혼합 --\\.\pipe\...-audio (WAV s16le, 10 ms 패킷)--> ffmpeg (오디오 1: Opus, 오디오 2: AAC-LC 48 kHz 128 kb/s)
ffmpeg --RTSP 127.0.0.1:8554--> MediaMTX --LL-HLS(1 s 세그먼트, 200 ms part)--> 시청 서버 --> 브라우저(hls.js / Safari HLS)
                                MediaMTX --WebRTC(UDP/TCP 8189, 첫 오디오 = Opus)--> 데스크톱 앱 수신(초저지연)
                                MediaMTX --runOnAvailable: ffmpeg -c copy (영상 + AAC)--> <스트림>/rec --record(fMP4, 재인코딩 없음)--> 녹화 폴더
시청 브라우저 --HTTP 8889 (FrameConsole.exe)--> MediaMTX(127.0.0.1 전용 포트: WebRTC HTTP, API, playback)
```

- 영상 타임스탬프는 프레임 수 기준(고정 프레임)이며, 음성은 같은 시점에 시작합니다. 인코더가 늦어 프레임을 건너뛰면 같은 길이의 음성도 버려 동기화를 유지합니다.
- 화질 래더: FFmpeg 하나(`Streamer::EnsureLadder`, 로그 분류 `ladder`)가 원본을 한 번 디코딩해 원본 복사본(`/<스트림>/src`)과 낮은 화질(`/<스트림>/720p` 등)을 모두 같은 `-start_time_realtime`으로 올리고, 이 경로들은 MediaMTX `useAbsoluteTimestamp`로 그 시각을 그대로 씁니다. 그래서 모든 HLS 화질의 PROGRAM-DATE-TIME과 fMP4 타임스탬프가 같습니다(실측: 5개 화질에서 같은 시각, 같은 tfdt, 같은 프레임). 방송 시작 때 함께 뜨고, 모든 화질 경로에 리더(HLS muxer, WebRTC)가 5분 동안 없으면 멈췄다가 다음 요청 때 다시 뜹니다. 미리 띄우는 이유: MediaMTX가 FFmpeg의 첫 RTCP 송신자 보고(SSRC를 알기 전에 도착)를 버려서 새 경로는 5초 뒤 둘째 보고부터 프레임을 받습니다(요청 때 띄우면 첫 시청자가 약 8초 대기). 시청자마다 인코더를 만들지 않습니다. 두 오디오 트랙은 그대로 복사하고, 녹화하지 않습니다. (이전: 화질마다 `runOnDemand` FFmpeg 하나. 화질마다 시작 시각이 달라 타임라인이 약 0.27초 어긋났고 hls.js 화질 전환에 빈 구간이 생겼습니다.)
- 화질별 프레임 레이트 정책: 낮은 화질도 원본 fps를 그대로 씁니다(`-fps_mode passthrough`: 원본 프레임을 모두 통과, 인코더 시간 단위도 원본 그대로 `-enc_time_base:v filter`). 키프레임은 원본 키프레임 위치에 둡니다(`-force_key_frames source`, GOP 상한은 원본과 같음). 원본 스트림은 낮추지 않고 원본보다 높은 화질은 만들지 않습니다.
- `live.m3u8`의 CODECS는 MediaMTX가 SPS에서 읽은 profile/level(API `tracks2[].codecProps`, 그 화질이 한 번 실행된 뒤)이고, 그전에는 High + 해상도·fps·비트레이트에 맞는 level입니다. BANDWIDTH는 설정/자동 비트레이트(VBR 상한) + AAC 128 kb/s, AVERAGE-BANDWIDTH는 이 방송에서 그 경로가 실제로 받은 평균입니다(10초 이상 측정; 아직 실행되지 않은 화질은 원본의 실측 비율, CBR은 BANDWIDTH와 같음).
- MediaMTX 1.21은 `index.m3u8`이 만든 세션 안에서만 미디어 재생 목록과 part를 내줍니다(없으면 401 `session not found`). 시청 서버는 스트림/화질마다 세션을 하나 만들어 모든 시청자 요청에 쓰고, 재생 목록 URI의 세션 쿼리는 지웁니다. 그래서 플레이어는 `video1_stream.m3u8`과 `audio3_stream.m3u8`을 바로 불러올 수 있고(원본 복사본과 낮은 화질 모두), 응답은 시청자마다 같습니다(재생 목록 `max-age=1`, init/part/segment `public, max-age=60`; 파일 이름이 muxer마다 다름).
- 출력 해상도는 선택한 화질 그대로이며 송출 중 바뀌지 않습니다(시청자·녹화가 한 규격 유지). 원본 비율이 다르면 여백은 인코더 한 곳에서만 들어가고, 짝수 반올림 때문에 생길 1~2px 검은 줄은 만들지 않습니다(FitRect).
- 자동 비트레이트: 0.07 bit/픽셀 × 60 × (fps/60)^0.75 × 인코더 계수(libx264 0.85), 0.5~200 Mbps. 기본 VBR(NVENC `-rc vbr -cq 23 -maxrate`, x264 `-crf 23 -maxrate`)에서 이 값은 상한입니다.

### 방송 전체 되감기(DVR)

```
MediaMTX --record (<스트림>/rec: 영상 + AAC)--> <recordRoot>/<방송ID>/<스트림>/rec/YYYY-MM-DD_HH-MM-SS-ffffff+zzzz.mp4  (1 s part, 60 s segment)
브라우저(hls.js / Safari) --GET /<스트림>/dvr.m3u8--> FrameConsole.exe (파일 색인과 재생 목록 1초 캐시, 모든 시청자 공유)
  EVENT 재생 목록: 파일마다 EXT-X-DISCONTINUITY + EXT-X-MAP(파일의 ftyp+moov 바이트 범위), 세그먼트마다 PROGRAM-DATE-TIME + EXTINF
브라우저 --GET /<스트림>/dvr/file?id=<방송ID>&f=<파일>[&s=<세그먼트>]--> init(Range 206) | 키프레임에서 시작하는 세그먼트
브라우저 --GET /<스트림>/dvr--> FrameConsole.exe --/list (1초 캐시, 모든 시청자 공유)--> MediaMTX playback
  {id, recording, ranges:[{startMs,endMs}], segments:[분할 파일 시작 ms], gopMs:1000, nowMs}
브라우저 --GET /<스트림>/dvr/media?id=<방송ID>&start=<ms>&duration=<ms>--> FrameConsole.exe --/get--> MediaMTX playback
  요청 시각부터 표시되는 fMP4 조각 | 404 아직 없음/녹화 빈 구간 | 409 다른 방송 | 업스트림 중단 시 종료 청크 없이 끊음
```

- MediaMTX는 녹화 루트를 작업 폴더로 실행하고 `recordPath`는 상대 경로(`./<방송ID>/%path/...%z`)라 사용자 경로의 공백·한글·%와 무관합니다. 녹화는 복사 경로 `<스트림>/rec`에서만 합니다(주 경로의 `runOnAvailable`: `ffmpeg -map 0:v:0 -map 0:a:1? -c copy`, 끝나면 다시 시작). 디스크 부족·용량 상한 때의 멈춤/재개(`record` PATCH), 색인, 보관 정리도 이 경로를 따릅니다. (설계 문서의 `runOnReady`는 MediaMTX 1.21에서 `runOnAvailable`이라는 이름입니다.)
- HLS DVR 세그먼트: MediaMTX 1.21의 녹화 part(moof+mdat)는 키프레임과 무관하게 약 1초마다 닫힙니다(측정: 파일 첫 part 말고는 part의 첫 영상 샘플이 키프레임이 아님). 그래서 part 묶음의 바이트 범위로는 키프레임으로 시작하는 세그먼트를 만들 수 없어, 세그먼트(약 4초)를 영상 키프레임에서 자르고 그 구간의 샘플(영상 + 같은 시간의 AAC)을 녹화 part에서 바이트 그대로 복사해 새 moof+mdat로 내보냅니다(재인코딩 없음; init은 파일의 ftyp+moov 바이트 범위). 세그먼트는 끝 키프레임 뒤 1초가 디스크에 완성된 뒤에만 목록에 오르고, 한 번 오른 세그먼트는 바뀌지 않습니다(EVENT). 가장 최근 파일이 5초 동안 커지지 않으면 끝난 것으로 보고 마지막 세그먼트까지 올립니다. EXTINF는 영상 샘플 길이, PROGRAM-DATE-TIME은 파일 이름 시각 + 디코드 시각입니다.
- `/dvr/file`은 현재 방송의 녹화 폴더에서 목록에 나온 파일만, 읽기 전용(공유 모드)으로, 목록에 나온 바이트(init과 목록 세그먼트가 쓰는 part)까지만 보냅니다. 끝난 파일과 목록 세그먼트는 `max-age=3600`, 아직 쓰는 파일의 Range 응답은 `no-cache`이고 `Content-Range`의 전체 길이는 `*`입니다.
- 이전 방식(MSE DVR, `/dvr/media`)도 유지하며 이제 H.264 + AAC 녹화를 내보냅니다(Opus 없음). 그 방식에서 브라우저(`work/console-ux.js`의 DVR 부분)는 MediaSource에 몇 초 단위 조각을 이어 붙입니다. 조각 시작은 분할 파일 시작 시각 + 1초(GOP) 격자에 맞춰 디코딩 낭비를 줄이고, 앞쪽 약 60 MB·뒤쪽 30 MB(방송 상한 비트레이트 기준)만 둡니다. 새 탐색·실시간 복귀·화질 변경은 진행 중인 탐색을 취소합니다.
- 지난 구간 재생 중에는 WHEP 세션을 닫습니다(소리 한 개). "실시간"은 WHEP를 다시 열고 첫 프레임이 나온 뒤 교체합니다.
- 시간축은 송출 PC의 시계(epoch ms)이며 UI 계약 `FrameUI.setTimeline({startMs,endMs,positionMs,mode})`, `frame:seek`, `frame:live`로 연결됩니다.

### 보안 경계

- WebView2 메시지는 `http://frame-console.example/`에서 온 것만 받고 명령 이름과 인수를 검사합니다. 다른 주소로의 이동과 새 창은 막습니다.
- 시청 포트에는 UI 파일·재생 스크립트, 목록·썸네일, 읽기 전용 정보, HLS·WHEP 전달, 시청 세션 집계, 현재 방송 ID로 제한된 DVR 읽기(녹화 폴더 목록에 나온 파일만, 목록 바이트까지), 채팅만 있습니다. 송출 시작/중지, 설정, 임의 파일 접근 경로는 없습니다. DVR 요청은 경로·방송 ID·시각·길이(최대 30초)를 검사한 뒤 재생 서버로 전달합니다.
- MediaMTX의 RTSP, API, WebRTC HTTP, playback은 127.0.0.1에만 열고, publish·API·playback 권한은 로컬 주소만 갖습니다.
- 목록 알림은 보낸 주소와 광고한 주소가 같을 때만 받습니다. 채팅 메시지와 이름은 서버가 정규화·검증하고 UI는 글자로만 표시합니다.
- 자식 프로세스는 이 프로그램의 Job Object에만 속하며 이름으로 다른 ffmpeg/mediamtx를 종료하지 않습니다.

## 개발용 확인

`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 환경 변수와 `--client-size=1440x1000` 인수로 실행하면 `tools/*.mjs` 검증 스크립트가 실제 앱 화면을 조작하고 캡처할 수 있습니다. 배포 실행에는 필요 없습니다.
UI 검사: 0.5.1 추가 지시(플레이어 조작부 자동 숨김)는 `work/player-ui.css` 한 파일로만 들어가며 `node tools/verify-ui-v051.mjs`가 0.5 잠금 그대로 + 이 파일만 차이임을 확인합니다(`UI_V051_ADDENDUM.json`). `verify-ui-v05.mjs`는 이 허용된 차이 때문에 마크업 해시 불일치를 보고합니다.
주요 스크립트: `test-crop.mjs`, `check-edges.mjs`, `save-frames.mjs`, `edge-window.ps1`, `window-control.ps1`(제목 표시줄 제외), `test-autohide.mjs`(자동 숨김), `smoke-v05.mjs`(목록·재생·채팅), `smoke-dvr.mjs`, `stress-dvr.mjs`, `measure-dvr.mjs`(되감기 위치 정확도), `test-dvr-restart.mjs`, `test-record-pause.mjs`(디스크 부족), `measure-storage.mjs`(크기·부하), `test-chat.mjs`, `capture-v05-states.mjs` + `compare-screens.mjs`(기준 화면 비교), `long-dvr.mjs`(장시간).
