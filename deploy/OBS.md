# OBS로 FRAME에 방송하기

기존 C++ Windows 앱과 설정은 유지한다. OBS를 쓸 때는 방송자 PC에서 OBS가 캡처·오디오 믹싱·인코딩·송출을 맡고, 서버의 MediaMTX와 Spring Boot가 방송 수신·목록 등록·HLS·채팅·DVR을 맡는다. Node 중계나 별도의 등록 프로그램은 실행하지 않는다.

## 현재 범위

- `RELAY_OBS_ENABLED=true`일 때 Spring이 MediaMTX의 `obs-*` RTMP 입력을 초당 한 번 확인하고 방송 목록에 자동으로 올린다.
- OBS에서 방송을 멈추면 `RELAY_MEDIA_GRACE_MS`(기본 15초) 동안 재연결을 기다린 뒤 종료한다. 이 시간 안에 재접속하면 같은 방송 ID를 유지한다. 종료 후 다음 송출은 새 ID를 받으며 이전 링크로 새 방송을 보지 않는다.
- 계정 로그인·채널 소유권 제품 API는 아직 없다. 로컬 실행기는 이 PC 전용 송출 토큰을 저장소 밖에 생성하고, OBS 모드의 개발 서버는 그 토큰을 서버 쪽에서만 사용한다. 실제 자격 증명을 공개 페이지의 정적 데이터나 저장소에 넣지 않는다. 인터넷 운영 설정은 아래처럼 운영자가 따로 준비한다.
- 백엔드 재시작 시 메모리의 방송 제목·방송 ID는 초기화된다. OBS가 계속 송출 중이면 새 ID로 다시 등록된다. 영속적인 방송 식별·채널 설정 저장은 제품 API 단계에서 다룬다.

## 이 PC에서 바로 실행

저장소 루트에서:

```powershell
node server/obs-local.mjs start
yarn --cwd apps/web dev --port 5360
```

`http://127.0.0.1:5360/_frame/studio/broadcast`를 열어 송출 주소와 키를 OBS에 복사한다. OBS의 방송 시작·종료에 따라 실제 수신 상태가 바뀐다. `yarn dev`는 아래 로컬 설정 파일을 자동으로 찾아 실제 연결을 사용한다. 실행기 자체는 화면을 캡처하거나 시험 영상을 보내지 않으며, 설치된 OBS의 프로필도 수정하지 않는다.

설정 위치를 명시하려면 `$env:FRAME_STUDIO_CONFIG = Join-Path $env:LOCALAPPDATA 'Frame/obs-local/studio.json'`을 지정할 수 있다. `yarn --cwd apps/web dev --mode obs --port 5360`도 지원한다. 정적 배포 빌드는 이 개발 서버용 비밀 설정을 포함하지 않는다.

- 최초 실행 때 `%LOCALAPPDATA%/Frame/obs-local/studio.json`에 로컬 송출 키를 생성한다. 재실행해도 같은 키를 유지한다. 이 파일을 공유하거나 저장소에 복사하지 않는다.
- Spring은 `127.0.0.1:18080`, OBS 입력은 `127.0.0.1:1935`, MediaMTX API는 `127.0.0.1:19997`, HLS는 `127.0.0.1:18888`, 내부 RTSP는 `127.0.0.1:18554`, 녹화 재생은 `127.0.0.1:19996`이다. 모두 이 PC에서만 접근할 수 있다.
- 이미 해당 포트를 쓰는 프로그램이 있으면 시작을 거부하고 그 프로그램을 종료하지 않는다. 시작·종료는 배타 잠금으로 직렬화하고, 죽은 잠금 소유자는 PID와 생성 시각을 확인해 복구한다. 실행기는 정확한 실행 인자 표시가 있는 PID만 종료하고, 준비 완료는 상태 응답과 실제 수신 포트의 소유 PID를 함께 확인한다.
- 준비물은 Java 21, 빌드된 `apps/api/build/libs/frame-api.jar`, 기존 `dist/FrameConsole/bin`의 MediaMTX·FFmpeg다. C++ 앱 실행은 필요 없다.

```powershell
node server/obs-local.mjs status
node server/obs-local.mjs stop
```

로컬 서버 로그·녹화는 같은 `%LOCALAPPDATA%/Frame/obs-local` 아래에 보관된다. 이 실행은 인터넷 공개 배포·서비스 계정 인증을 대신하지 않는다.

## 1. 채널 하나 준비하기

예시 채널 경로는 `obs-spring`이다. `obs-` 접두사는 OBS의 단일 AAC 트랙 녹화 규칙을 기존 네이티브의 Opus+AAC 규칙과 구분한다.

1. 24자 이상 임의 토큰을 생성하고 서버의 비밀 파일에만 보관한다. 기존 `RELAY_PUBLISHER_TOKENS_FILE`에 `<새 토큰> obs-spring` 한 줄을 넣는다. `*` 또는 여러 토큰이 공유하는 경로는 OBS 자동 등록에 사용하지 않는다.
2. MediaMTX의 사용자 `obs-spring`에 같은 토큰의 SHA-256 Base64 해시를 `MTX_AUTHINTERNALUSERS_3_PASS=sha256:<해시>`로 지정한다. 사용자 이름과 허용 경로는 [mediamtx-relay.yml](mediamtx-relay.yml)에 있다. 채널을 늘릴 때는 같은 형식의 **정확한 경로별** publish 권한만 추가한다.
3. Spring 환경에 다음을 설정한다.

```text
RELAY_OBS_ENABLED=true
RELAY_OBS_SERVER_URL=rtmp://127.0.0.1:1935
```

4. 같은 PC에서만 시험할 때 MediaMTX에 다음을 설정한다. 평문 RTMP·RTSP는 모두 루프백에만 열리며 이 시험 실행에는 인증서가 필요 없다. 기존 C++ 앱의 파일·설정은 변경하지 않는다.

```text
MTX_RTMP=true
MTX_RTMPENCRYPTION=no
MTX_RTSPENCRYPTION=no
MTX_WEBRTCADDITIONALHOSTS=127.0.0.1
```

인터넷에서 송출받는 운영 설정은 위의 `no` 대신 기존 RTSPS와 RTMPS의 `optional` TLS 설정을 유지하고, 인증서 경로를 `MTX_RTSPSERVERKEY`, `MTX_RTSPSERVERCERT`, `MTX_RTMPSERVERKEY`, `MTX_RTMPSERVERCERT`로 지정한다.

기본 MediaMTX 설정의 평문 RTMP는 `127.0.0.1:1935`에만 열린다. 인터넷 입력은 OBS가 신뢰하는 CA의 서버 인증서와 `rtmps://<송출 호스트>:1936`을 사용하고 `RELAY_OBS_SERVER_URL`도 그 주소로 맞춘다. OBS는 신뢰되지 않은 자체 서명 인증서를 거부하므로, 이 문서의 같은 PC 시험은 RTMP 루프백으로 시작한다. Caddy의 HTTP 프록시는 RTMPS 입력을 중계하지 않는다. MediaMTX API·HLS·녹화 재생 서버는 계속 루프백 전용으로 둔다.

## 2. OBS 설정

OBS의 **설정 → 방송**에서 서비스를 **사용자 지정**으로 선택한다.

| 항목 | 값 |
| --- | --- |
| 서버 | 같은 PC 시험: `rtmp://127.0.0.1:1935` / 인터넷: `rtmps://<송출 호스트>:1936` |
| 스트림 키 | `obs-spring?user=obs-spring&pass=<위에서 만든 토큰>` |

토큰에 URL 예약 문자가 있으면 `pass` 값은 URL 인코딩한다. 키 전체를 다른 사람에게 공유하거나 캡처에 표시하지 않는다. 비밀번호 입력란을 따로 쓰는 OBS 인증 모드 대신 위 URL 쿼리 형식을 사용한다.

첫 시험은 H.264, AAC, 720p/30fps, B 프레임 0, 키프레임 간격 1초로 시작한다. 화면·시스템 소리·마이크·해상도·비트레이트·장면 전환·방송 시작/종료는 OBS에서 조작한다. 일반 시청자는 기존 LL-HLS 경로를 사용하며 WebRTC로 전환하지 않는다.

## 3. 송출자 전용 API

기존 송출 토큰을 `Authorization: Bearer <토큰>`으로 보내야 한다. 해당 `obs-*` 경로를 명시적으로 단독 소유하는 토큰만 접근할 수 있다. 응답은 `Cache-Control: no-store`다.

| 요청 | 결과 |
| --- | --- |
| `GET /api/obs/obs-spring` | `state`(`waiting`, `live`, `reconnecting`, `unavailable`), `broadcastId`, `mediaReady`, `title`, `publisher`, `serverUrl`, 본인 `streamKey` |
| `PUT /api/obs/obs-spring` | JSON `{ "title": "방송 제목", "publisher": "채널 이름" }`를 메모리에 저장. 제목 최대 200 UTF-8 바이트, 채널 이름 최대 100 바이트. 정상 204 |

GET은 요청자가 이미 인증에 쓴 자기 토큰으로 키를 구성한다. 다른 사람의 토큰을 조회하거나 새 토큰을 발급하지 않는다. 공개 `GET /api/broadcasts`와 시청 응답에는 송출 키가 들어가지 않는다. OBS 송출에 API 호출은 필수가 아니며, 메타데이터를 주지 않으면 경로를 바탕으로 기본 제목을 사용한다.

## 검증

```powershell
node server/verify/obs-e2e.mjs
```

이 검사는 시험 영상·음성을 FFmpeg의 RTMP 출력으로 보내 OBS와 같은 H.264+AAC 수신 경로를 검사한다. OBS GUI·다른 PC·인터넷 회선 검증과 구분해서 기록한다. 다른 MediaMTX/FFmpeg 부하 시험과 동시에 실행하지 않는다.

기준: [MediaMTX OBS 입력](https://mediamtx.org/docs/publish/obs-studio), [RTMP 입력](https://mediamtx.org/docs/publish/rtmp), [인증](https://mediamtx.org/docs/features/authentication).
