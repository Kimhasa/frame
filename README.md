# FRAME Console

Windows 애플리케이션 창 또는 모니터 화면과 오디오를 송출하고, 같은 내부망의 다른 PC에서 브라우저로 시청하는 프로그램입니다. C++17, Windows Graphics Capture, WebView2, FFmpeg, MediaMTX를 사용합니다.

현재 UI는 0.5 기준이며 플레이어 조작부 자동 숨김은 0.5.1 추가 지시로 관리합니다. 프로그램 창·모니터 선택, 수신 목록, 실시간 재생, 방송 시작부터 되감기, 실시간 복귀와 방송별 채팅을 구현한 상태입니다. 실제 다른 PC 간 수신과 인터넷 공개 접속은 별도 검증이 필요합니다.

## 빌드

Windows x64, Visual Studio 2022 Build Tools(C++ 도구·Windows SDK·CMake·Ninja), Node.js 22 이상이 필요합니다. 도구 버전과 상세 절차는 [native/README.md](native/README.md)를 확인하세요.

프로젝트 루트에서 다음 순서로 실행합니다.

```bat
node tools\fetch-deps.mjs
node work\build-console.mjs
node tools\verify-ui-v051.mjs
build\vsbuild.cmd
node tools\package-dist.mjs
```

실행 파일은 `dist/FrameConsole/FrameConsole.exe`, 배포 ZIP은 `dist/FrameConsole-0.5.0-win64.zip`에 생성됩니다. 실행 파일과 설치 파일은 Git 저장소에 포함하지 않습니다.

`deps/manifest.json`에 의존성 버전·다운로드 주소·SHA-256이 고정되어 있습니다. 최초 준비에는 인터넷이 필요하며, 반입용 오프라인 빌드는 내려받은 `deps/archives/`와 필요한 개발 도구를 별도로 준비해야 합니다. Visual Studio 설치 파일은 저장소에 포함하지 않습니다.

## 파일 구성

| 경로 | 내용 |
| --- | --- |
| `native/` | C++ 호스트, 캡처·오디오·송출·HTTP·채팅·DVR 구현 |
| `work/` | UI 작성 소스와 UI 빌드 스크립트 |
| `outputs/` | 빌드된 UI와 로컬 Pretendard 폰트 |
| `tools/`, `packaging/` | 검증·의존성 준비·배포 스크립트와 설정 예시 |
| `reference/`, `reference-v05/` | 보존하는 UI 원본과 비교 기준 |
| `verification/REPORT.md` | 기존 구현의 측정 결과와 미검증 항목 |

UI 기준 파일은 SHA-256으로 검사하므로 Git 체크아웃 시 줄바꿈을 자동 변환하지 않도록 `.gitattributes`를 설정했습니다. 기존 UI 원본과 잠금 해시는 임의로 갱신하지 않습니다.

## 이어서 작업하기

`START_HERE.txt`, `UI_HANDOFF.txt`, `CLAUDE_FUNCTIONAL_TASKS.txt`, `CLAUDE_CAPTURE_PLAYER_ADDENDUM.txt`를 먼저 확인하세요. 현재 실제 구현 상태와 검증 보고서를 함께 읽고 이미 구현된 기능을 보존해야 합니다.

현재 시청 서버는 내부망 사용을 기준으로 합니다. 인터넷 중계 서버 배포, 외부 송출과 인터넷 시청 주소 제공은 아직 추가 작업이 필요합니다.

## 포함 의존성

Pretendard 폰트는 OFL, nlohmann/json은 MIT 라이선스를 따릅니다. 다운로드하는 FFmpeg 빌드는 GPL v3이며 MediaMTX와 WebView2에도 각 배포 조건이 적용됩니다. 배포 시 `deps/manifest.json`과 패키징 과정에서 포함하는 라이선스 문서를 확인하세요.
