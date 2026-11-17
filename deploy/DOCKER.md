# Docker 개발 환경

이 구성은 PostgreSQL·Redis를 Docker Compose로 실행한다. React/Vite, Spring Boot, OBS·MediaMTX·FFmpeg는 호스트에서 개발한다. 컨테이너 분리는 마이크로서비스 분리가 아니며 제품 API는 Spring Boot 하나다. Node 파일은 실행 도구이고 애플리케이션 백엔드는 아니다.

```text
브라우저 → Vite :5360 → Spring Boot :18080 → PostgreSQL :25432 [Docker]
                                         → Redis      :26379 [Docker]
OBS → MediaMTX → Spring Boot → 브라우저 HLS
```

## 준비와 실행

Windows에서 Node.js 24.x, JDK 21(`JAVA_HOME` 또는 `java` PATH), Corepack, Docker Desktop의 Linux 컨테이너 엔진과 Docker Compose가 필요하다. 웹의 `apps/web/package.json`이 Yarn 4.18.1을 고정한다. 아래 로컬 OBS 실행기는 Windows 전용이다.

### 다른 PC에서 처음 받았을 때

저장소 루트에서 먼저 웹 의존성·API jar·미디어 실행 파일을 준비한다. C++ 앱을 빌드할 필요는 없다. `fetch-deps.mjs`는 `deps/manifest.json`의 고정 주소·SHA-256으로 외부 실행 파일을 내려받는다. `build/`, `dist/`, `node_modules/`, DB 볼륨과 개인 설정 파일은 Git에 포함되지 않으므로 새 PC에서 준비해야 한다.

```powershell
Push-Location apps/web
corepack yarn install --immutable
Pop-Location

.\apps\api\gradlew.bat -p apps/api bootJar
node tools/fetch-deps.mjs
New-Item -ItemType Directory -Force -Path dist/FrameConsole/bin | Out-Null
Copy-Item -LiteralPath build/third_party/mediamtx/mediamtx.exe -Destination dist/FrameConsole/bin/mediamtx.exe
Copy-Item -LiteralPath build/third_party/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe -Destination dist/FrameConsole/bin/ffmpeg.exe
```

웹은 `apps/web`에서 Corepack을 실행해야 해당 폴더의 `packageManager` 고정 버전을 사용한다. `gradlew.bat`는 Gradle Wrapper를 사용하므로 Gradle을 따로 설치하지 않는다. 미디어 실행 파일만 복사하는 위 과정은 기존 C++ 소스·시안·잠금 해시를 변경하지 않는다.

### DB·API·웹 실행

저장소 루트에서 다음을 실행한다.

```powershell
node server/product-docker.mjs prepare
node server/product-docker.mjs check
node server/product-docker.mjs start

$env:FRAME_PRODUCT_CONFIG = "$env:LOCALAPPDATA\Frame\product-docker\config.json"
node server/obs-local.mjs start
Push-Location apps/web
corepack yarn dev --port 5360 --strictPort
Pop-Location
```

`http://127.0.0.1:5360/_frame/`을 연다. 빈 제품 DB에는 API 시작 시 Flyway V1~V20이 적용되며 회원가입 후 본인 채널이 생성된다. 방송이 없을 때도 계정·채널·설정 화면을 개발할 수 있다. OBS 실제 송출은 [OBS.md](OBS.md)를 따른다. 기본 설정은 새 PC마다 로컬 송출 키를 별도 생성한다. 다른 PC의 설정·토큰·회원 DB·세션을 Git으로 옮기지 않는다.

이미 API가 실행 중이면 설정을 선택한 같은 셸에서 `node server/obs-local.mjs restart-api`로 API만 교체한다. Vite도 같은 환경 변수로 다시 실행한다. 설정 선택은 현재 셸에만 적용한다. 공개 다시보기 보관본은 실행기가 `%LOCALAPPDATA%/Frame/obs-local/vod`에 따로 저장한다. 클립 보관본은 같은 폴더의 형제 clips에 저장한다. 두 보관본은 원본 녹화의 6시간 보관과 별개이며, DB 볼륨과 영상 파일은 함께 백업해야 한다. API가 선택한 Docker 설정과 Vite의 설정이 같아야 한다.

`prepare`는 비밀 파일을 저장소 밖 `%LOCALAPPDATA%/Frame/product-docker`에 만든다. 다른 경로는 `FRAME_DOCKER_DIR`로 지정할 수 있다. Linux/macOS 기본 경로는 `~/.frame/product-docker`이며, 호스트 API 실행에는 해당 `config.json`의 접속 값을 환경 변수로 전달한다. 기존 Windows 실행기의 기본 설정은 그대로 보존한다.

Docker의 두 데이터 볼륨은 기존 PC의 PostgreSQL `15432`·Redis `16379`와 별개다. 기존 회원을 자동으로 복사하지 않으므로 새 환경에는 웹에서 가입한다. 기존 데이터를 이관하려면 별도의 백업·복원 작업이 필요하다. DB 비밀번호는 기존 로컬 설정이 있으면 그 선택을 재사용하고, 나머지 비밀은 임의 생성한다. 재실행해도 비밀번호를 교체하지 않는다.

```powershell
node server/product-docker.mjs status
node server/product-docker.mjs stop
```

`stop`은 이 Compose 프로젝트의 두 서비스만 멈추며 볼륨을 남긴다. 실행기는 볼륨 삭제 명령을 제공하지 않는다. `FRAME_PRODUCT_CONFIG`를 제거하면 기존 PC 설정으로 돌아간다. 두 DB의 회원·세션은 서로 다른 데이터다.

직접 Compose 명령을 쓰려면 `FRAME_DOCKER_DIR`에 준비한 비밀 폴더를 지정한 뒤 `docker compose -f deploy/compose.yaml up -d --wait`를 실행한다.

컨테이너 DB가 준비된 뒤 백엔드 전체 검사를 실행할 때는 `FRAME_PRODUCT_TEST_CONFIG`를 Docker의 `config.json` 경로로 지정하고 `apps/api`에서 `gradlew.bat test --rerun-tasks`를 실행한다. 이전 native 환경의 검사 결과가 재사용되지 않았는지 확인한다. 검사는 `verifyDbUrl`의 별도 검증 DB와 임의 schema·Redis namespace를 사용한다. 실제 회원 DB로 테스트를 실행하지 않는다.

검증만 할 때는 `FRAME_PRODUCT_CONFIG`를 바꾸지 않는다. `FRAME_PRODUCT_TEST_CONFIG`만 지정하면 현재 앱의 DB 연결을 유지하면서 Docker 검증 DB를 따로 검사할 수 있다.

## DB와 Flyway의 역할

| 구성 | 역할 |
| --- | --- |
| `compose.yaml` | 공식 PostgreSQL 17.11·Redis 8.10.3, 루프백 포트, 지속 볼륨, 인증 healthcheck |
| `docker/01-product.sql` | 빈 PostgreSQL 볼륨에 관리 역할·제한된 앱 역할·제품/검증 DB 준비 |
| `apps/api/src/main/resources/db/migration/` | Spring Boot 시작 시 Flyway가 제품 테이블의 버전과 변경 이력을 관리 |

앱 테이블을 Docker 초기화 SQL에 복사하지 않는다. 최초 실행에는 `db/migration`의 버전들이 순서대로 적용되고 재시작에는 이미 적용한 SQL을 재실행하지 않는다. 현재 V1(회원·채널·팔로우), V2(가입 동의), V3(방송 예약), V4(시청 기록), V5(채널 프로필·주소 예약·신고 접수), V6(운영자 플래그·신고 관리), V7(개인 알림·전송 표식·시작 기준 시각), V8(채팅 정책·계정 차단), V9(방송 투표·선택지·계정별 표), V10(비공개 질문·답변·명시적 공개 고정), V11(채널 포인트·원장·보상·교환 요청), V12(무료 미션·상태 변경 이력), V13(방송 분석의 관찰 집계), V14(비공개 녹화의 관찰 구간·파일 목록), V15(공개 다시보기의 보관본·공개 범위·준비 상태), V16(클립 구간·요청 중복 방지·공개 범위·보관 파일), V17(다시보기·클립 시청 위치·완료 상태·삭제 버전), V18(명령어 채팅봇 설정·자동 응답), V19(API 키·웹훅·변경 receipt·전송 기록), V20(멤버십 플랜·가입·청구 원장·변경 receipt)을 사용한다. 적용한 SQL은 수정하지 않고 다음 `V21__설명.sql`을 추가한다. checksum 불일치 시 시작을 실패시키며 자동 `repair`·`clean`·baseline 처리를 하지 않는다. Redis는 세션 저장소라 Flyway 대상이 아니다.

PostgreSQL의 `frame_admin`은 최초 준비용이고 API는 `frame_app`으로 접속한다. 비밀번호는 Compose secrets 파일로 전달한다. Redis 인증은 ACL 파일로 설정하며 환경 변수 `REDIS_PASSWORD`만 선언하는 방식을 사용하지 않는다. healthcheck는 실제 앱 DB 인증과 Redis 인증을 확인한다. [PostgreSQL 이미지](https://hub.docker.com/_/postgres), [Redis 이미지](https://hub.docker.com/_/redis), [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [Flyway 설정](https://docs.spring.io/spring-boot/appendix/application-properties/)

## 이 PC의 확인 범위

2026-11-12 사용자 요청으로 공식 서명·SHA-256을 확인한 Docker Desktop 4.99.0을 사용자 범위에 설치하고 WSL을 3.0.5로 갱신했다. 가상 머신 플랫폼·WSL 선택 기능을 활성화했으며 설치 결과가 Windows 재시작 필요를 반환했다. Docker CLI 29.9.3·Compose 5.7.0·WSL 버전 조회와 Compose 구성 검사를 확인했다.

당시 재부팅은 자동으로 실행하지 않았고, 컨테이너 시작과 Docker DB의 Flyway 적용은 확인하지 않았다. 당시 Flyway의 실제 PostgreSQL 검사는 별도 네이티브 검증 DB에서 수행했다.

2026-11-16 현재 PC에서는 Docker Desktop 실행 파일은 있으나 설치 등록이 없어 시작이 실패했다. 사용자의 재설치 요청으로 공식 Docker Desktop 4.99.0 설치 프로그램의 SHA-256과 Docker Inc 서명을 확인하고 사용자 범위에 다시 설치했다. 설치 등록 복구, Linux 엔진 29.9.3 응답, 이 Compose의 PostgreSQL `25432`·Redis `26379` 인증 healthcheck `healthy`를 확인했다. 제거 명령·수동 레지스트리 수정·기존 데이터 삭제·OS 재부팅은 하지 않았다. 준비 과정에 사용한 별도 네이티브 PostgreSQL·Redis는 정상 종료했으며 데이터 파일을 보존했다. Docker 재설치 결과는 [안전한 실행 결과](../verification/product/docker-reinstall-result.json), 제품 기능과 DB 검증은 [제품 검증 기록](../verification/product/REPORT.md)에 기록한다.
