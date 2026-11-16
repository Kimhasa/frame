# FRAME Console

Windows 애플리케이션 창 또는 모니터 화면과 오디오를 송출하고, 다른 PC와 휴대폰에서 브라우저만으로 시청하는 프로그램입니다. 같은 네트워크에서는 송출 PC가 직접 시청 서버가 되고, 다른 인터넷 회선의 시청자는 중계 서버(`apps/api/`, `deploy/`)를 거칩니다. C++17, Windows Graphics Capture, WebView2, FFmpeg, MediaMTX를 사용합니다.

콘솔 UI는 0.5 기준에 허용된 추가 변경(0.5.1, 0.6, 0.6.1)을 더한 상태이고, 각 변경은 `UI_V0*_ADDENDUM.json`에 기록되어 있습니다. 구현된 기능은 다음과 같습니다.
- 프로그램 창·모니터 선택, 수신 목록
- 실시간 재생(LL-HLS 자동·수동 화질)
- 방송 시작부터 되감기, 실시간 복귀
- 방송별 채팅

실제 다른 PC 간 수신과 인터넷 공개 접속은 별도 검증이 필요합니다.

## 웹·API 개발 시작

새 PC에서는 Node.js 24.x·JDK 21·Corepack·Docker Desktop의 Linux 엔진을 준비한 뒤 [Docker 개발 환경](deploy/DOCKER.md#다른-pc에서-처음-받았을-때)의 최초 준비와 실행 명령을 따른다. React는 `apps/web`의 Yarn Berry 고정 버전을 사용하며 Spring Boot가 PostgreSQL의 Flyway V1~V15를 적용한다. 미디어 실행 파일은 고정 의존성 목록으로 다시 준비하므로 웹·API 작업에 C++ 빌드는 필요하지 않다. 회원·비밀 설정·송출 키는 각 PC에서 따로 생성한다.

실제 제품 API에는 계정·채널·팔로우·방송 예약·시청 기록·신고·알림·채팅 관리·투표·질문·시청 포인트와 보상·무료 미션·방송 분석·비공개 녹화 관리·공개 다시보기가 연결돼 있다. 무료 미션은 시청자가 제안하고 방송자가 진행·결과를 처리하며, 기한과 방송 종료에 따른 만료 및 변경 이력을 저장한다. 방송 분석은 실제 송출을 관찰한 시간과 연결 수 표본을 저장해 기간 요약·일별 그래프·방송 목록으로 제공하며, 실제 사람 수나 재생 시간을 뜻하지 않는다. 서버 녹화 관리는 새로 관찰해 방송·채널 소유가 확인된 완료 파일의 비공개 재생·다운로드와 목록 숨김·복원을 제공한다. 방송 경계가 불명확한 파일은 재생을 제한하며 현재 서버 원본 보관은 6시간이다. 방송자가 선택해 공개한 완료 파일은 별도 보관본으로 복사하고, 시청자는 로그인 없이 다시보기 목록·채널·공유 링크에서 재생한다. 공개 범위를 비공개로 바꾸면 새 목록·상세·영상 요청을 차단한다. 유료 미션·멤버십·수익과 정산·계정별 결제, 클립, 외부 도구와 개발자 설정의 실제 제품 연동은 후속 작업이다. 미연동 메뉴에서 저장이나 거래가 성공한 것처럼 표시하지 않는다. 최신 검증 범위는 [제품 검증 기록](verification/product/REPORT.md)에서 확인한다.

## 빌드

React·Spring Boot 제품 개발의 PostgreSQL·Redis는 [Docker Compose 실행](deploy/DOCKER.md)으로 준비할 수 있습니다. 계정·채널 프로필·주소 예약·신고·팔로우·방송 예약·시청 기록·알림·채팅 정책과 계정 차단·방송 투표·질문과 답변·비현금 포인트와 보상·무료 미션·방송 분석·녹화 관리·공개 다시보기의 DB 변경은 Spring Boot의 Flyway 마이그레이션이 관리합니다. 기존 PC 데이터 실행 경로는 [PRODUCT_LOCAL.md](deploy/PRODUCT_LOCAL.md)에 있습니다. 아래 빌드는 보존 중인 C++ 송출 앱에 해당합니다.

Windows x64, Visual Studio 2022 Build Tools(C++ 도구·Windows SDK·CMake·Ninja), Node.js 22 이상이 필요합니다. 도구 버전과 상세 절차는 [native/README.md](native/README.md)를 확인하세요.

프로젝트 루트에서 다음 순서로 실행합니다.

```bat
node tools\fetch-deps.mjs
node work\build-console.mjs
node tools\verify-ui-v06.mjs
build\vsbuild.cmd
node tools\package-dist.mjs
```

실행 파일은 `dist/FrameConsole/FrameConsole.exe`, 배포 ZIP은 `dist/FrameConsole-0.5.0-win64.zip`에 생성됩니다. 실행 파일과 설치 파일은 Git 저장소에 포함하지 않습니다.

`deps/manifest.json`에 의존성 버전·다운로드 주소·SHA-256이 고정되어 있습니다. 최초 준비에는 인터넷이 필요하며, 반입용 오프라인 빌드는 내려받은 `deps/archives/`와 필요한 개발 도구를 별도로 준비해야 합니다. Visual Studio 설치 파일은 저장소에 포함하지 않습니다.

## 파일 구성

| 경로 | 내용 |
| --- | --- |
| `apps/web/` | React 공개 시청 웹(Yarn Berry) |
| `apps/api/` | Spring Boot 백엔드: 중계와 PostgreSQL·Redis 기반 회원·채널 프로필·팔로우·방송 예약·시청 기록·알림·신고 관리·채팅 정책과 계정 차단·방송 투표·질문과 답변·비현금 포인트와 보상·무료 미션·방송 분석·녹화 관리·공개 다시보기 API. 실행 방법은 [apps/api/README.md](apps/api/README.md) |
| `deploy/` | 중계 서버 배포 설정: `frame-api.jar`를 실행하는 systemd 단위, 환경 예시, Caddy와 서버용 MediaMTX 설정([deploy/README.md](deploy/README.md)) |
| `server/` | 검증 스크립트(`server/verify/`)와 이전 Node 중계(배포하지 않음, 검증의 비교 기준) |
| `native/` | C++ 호스트, 캡처·오디오·송출·HTTP·채팅·DVR 구현 |
| `work/` | UI 작성 소스와 UI 빌드 스크립트 |
| `outputs/` | 빌드된 UI와 로컬 Pretendard 폰트 |
| `tools/`, `packaging/` | 검증·의존성 준비·배포 스크립트와 설정 예시 |
| `reference/`, `reference-v05/` | 보존하는 UI 원본과 비교 기준 |
| `verification/REPORT.md` | 기존 구현의 측정 결과와 미검증 항목. 배포하는 Spring 백엔드의 검증은 [verification/spring/RESULTS.md](verification/spring/RESULTS.md) |

UI 기준 파일은 SHA-256으로 검사하므로 Git 체크아웃 시 줄바꿈을 자동 변환하지 않도록 `.gitattributes`를 설정했습니다. 기존 UI 원본과 잠금 해시는 임의로 갱신하지 않습니다.

## 이어서 작업하기

설계와 지시는 [docs/FRAME_DESIGN.md](docs/FRAME_DESIGN.md) 하나에 있습니다. 현재 상태, 지켜야 할 제약, 구현 설계, 다음 작업(React 공개 웹과 제품 API의 상세 설계)이 들어 있습니다. 화면 기준은 시안 [design/2026-10-28/dist/index.html](design/2026-10-28/dist/index.html)입니다. 실행 결과는 [verification/REPORT.md](verification/REPORT.md)에 있습니다.

이전 지시·인계·목록 문서(`CLAUDE_*.txt`, `START_HERE.txt`, `UI_HANDOFF.txt`, `FEATURE_*`, `docs/inventory` 등)는 2026-11-09에 정리했습니다. 원문은 git 이력(커밋 `4c00651`)과 저장소 밖 백업 `frame-docs-backup-2026-11-09.zip`에 있습니다.

일반 브라우저 시청은 LL-HLS이고, WebRTC는 데스크톱 앱 자체 수신용입니다. 중계 서버 코드와 배포 예시는 있지만 실제 공개 서버 배포, 다른 인터넷 회선, 1,000명 시청은 아직 검증하지 않았습니다.

## 포함 의존성

Pretendard 폰트는 OFL, nlohmann/json은 MIT 라이선스를 따릅니다. 다운로드하는 FFmpeg 빌드는 GPL v3이며 MediaMTX와 WebView2에도 각 배포 조건이 적용됩니다. 배포 시 `deps/manifest.json`과 패키징 과정에서 포함하는 라이선스 문서를 확인하세요.
