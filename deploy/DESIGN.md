# 인터넷 시청 배포 방식 설계 기록 (NET-04)

작성 2026-10-28, 2026-11-02 갱신(일반 시청을 HLS로 전환 — 리드 설계 결정). 대상: 한 방송 최대 동시 시청 1,000명(목표치, 현재
보장값 아님), 모바일 브라우저, 시청자별 자동 화질(ABR), DVR. 이 문서의 수치 중 "측정"이라고 적은 것만 실제 실행 결과다
(deploy/verification/). 나머지는 설계상 추정이다. 2026-10-28 판(WebRTC 기본 + LL-HLS 대체)은 당시 결정 기록으로 아래 "이전 결정"에 남긴다.

2026-11-10: 중계 웹 서비스(이 문서의 "relay")의 구현을 Node(`server/relay.mjs`)에서 Spring Boot(`apps/api`의 `frame-api.jar`)로 바꿨다.
아래 결정과 계약은 그대로이고 코드 위치만 달라졌다. Node 구현은 배포하지 않고 검증의 비교 기준으로 남아 있다. Spring 대상
검증은 `verification/spring/RESULTS.md`에 있다. 날짜가 붙은 측정 기록의 "relay.mjs"는 당시 구현을 가리킨다.

## 결정

1. **송출 PC → 중계 서버: 원본 1개를 한 번만 올린다.** Windows 앱이 로컬 MediaMTX의 원본 경로를 자기 FFmpeg(`-c copy`,
   재인코딩 없음)로 RTSPS(TLS, 송출 PC별 계정)로 중계 MediaMTX에 올리고, 끝나면 백오프로 다시 띄운다. 송출 PC 업로드는 시청자 수와 무관하게 원본 비트레이트 1배다(+ 송출 PC가 직접 만든 화질을 함께
   올리면 그만큼 추가).
2. **시청 경로: 모든 브라우저는 LL-HLS, WebRTC는 초저지연 용도만.** 일반 시청(목록에서 연 페이지, 첫 연결·재연결·실시간 복귀)은
   relay의 `/<path>/live.m3u8`(화질별 영상 + AAC, MediaMTX LL-HLS: 1 s 세그먼트·200 ms 파트·블로킹 재요청)을 hls.js 1.5.20
   (MSE/ManagedMediaSource) 또는 Safari 기본 HLS로 재생한다. WebRTC(WHEP)는 데스크톱 앱 자체 수신(송출자 확인, 같은 망의 다른 PC
   방송)과, HLS를 전혀 못 쓰는 브라우저에만 쓴다(연결마다 한 번 정하고 바꾸지 않음). 이유: HTTP만으로 도달(443), CDN에 얹을 수
   있음, 표준 ABR(master playlist), iPhone Safari 기본 재생과 DVR이 같은 방식. 대가는 지연: 앱 루프백 측정 1.6 s(화면 바코드),
   이 relay e2e의 hls.js 지연 값은 11장 표(인터넷 미측정).
3. **화질: 방송마다 화질 래더 FFmpeg 하나(2026-11-02 갱신).** 원본을 한 번만 디코딩해 원본 복사본 `<path>/src`와 하위
   화질 `<path>/<h>p`를 모두 같은 `-start_time_realtime`으로 올리고, 그 경로들은 MediaMTX `useAbsoluteTimestamp`로 그 시각을
   그대로 쓴다(apps/api의 quality/Ladders.java — 이전 Node 구현은 server/lib/ladder.mjs, 앱은 Streamer::EnsureLadder). 그래서 모든 HLS 화질의 PROGRAM-DATE-TIME과 fMP4
   타임스탬프가 같다(앱 실측: 5개 화질 같은 시각·같은 tfdt·같은 프레임). 시청자 수와 무관하게 인코더는 방송당 하나이고 모든
   시청자가 공유한다. 미디어가 들어오면 미리 띄우고(새 경로는 FFmpeg의 둘째 RTCP 보고, 즉 5 s 뒤부터 받으므로 요청 때 띄우면 첫
   시청자가 약 8 s 기다림), 모든 화질의 리더가 `RELAY_LADDER_IDLE_MS`(기본 5분) 동안 없으면 멈춘다. CPU가 없는 서버에서는
   `RELAY_RENDITIONS`를 비워 원본만 둔다. 원본보다 큰 화질은 만들지 않는다.
   (이전 결정, 2026-10-28: 화질마다 `runOnDemand` FFmpeg 하나. 화질마다 시작 시각이 달라 타임라인이 약 0.3 s씩 어긋났다.)
4. **DVR: 중계 서버가 영상 + AAC를 재인코딩 없이 녹화하고 HLS로 다시 내보낸다.** 원본 경로가 준비되면 MediaMTX
   `runOnAvailable`(1.21의 이름, 설계의 runOnReady) FFmpeg가 영상과 둘째 음성(AAC)만 복사 경로 `<path>/rec`로 올리고 그 경로만
   녹화한다(fMP4, 1 s part, 60 s 파일). relay가 그 파일을 `dvr.m3u8`(EVENT, 파일마다 EXT-X-MAP = ftyp+moov 바이트 범위, 키프레임에서
   자른 약 4 s 세그먼트, 파일 사이 DISCONTINUITY, PROGRAM-DATE-TIME)과 `dvr/file.mp4?id=&f=[&s=]`(Range)로 낸다. 앱
   (native/src/recorder.cpp)과 같은 규칙을 apps/api의 dvr/RecordFile.java로 옮겼다(이전 Node 구현은 server/lib/fmp4.mjs): MediaMTX의 녹화 part는 키프레임과 무관하게 1 s마다
   닫히므로 part 묶음은 키프레임으로 시작하지 않는다 → 세그먼트를 키프레임에서 자르고 그 구간의 샘플을 바이트 그대로 새
   moof+mdat로 옮긴다(재인코딩 없음). 기존 `/<path>/dvr`·`/<path>/dvr/media`(MSE, 이제 H.264 + AAC)는 이전 페이지용으로 남긴다.
5. **확장 순서: 측정 → 병목에 맞춰 확장.** 1단계는 중계 서버 1대(지금 구현·로컬 검증). HLS 응답이 시청자와 무관하고
   쿠키가 없으므로(아래 6) 송신량이 한계에 닿으면 HLS를 CDN에 얹는 것이 다음 단계다(규칙: README 9장, 미검증). 그다음이
   MediaMTX 엣지 노드(원본 중계에서 RTSPS로 당겨 오는 `source:` 경로). 처음부터 무료 서버로 1,000명을 받는다고 약속하지 않는다.
6. **CDN에 안전한 HLS와 미디어와 분리된 시청자 집계.** relay가 경로·화질마다 MediaMTX HLS 세션 하나를 모든 시청자와 함께
   쓰고(MediaMTX 1.21은 index.m3u8이 만든 세션 없이 미디어 재생 목록을 주지 않는다), 쿠키 확인을 대신 처리하며, 재생 목록의
   세션 값을 지운다. 그래서 `Set-Cookie`가 없고 모든 시청자가 같은 바이트를 받는다. 같은 블로킹 재요청은 MediaMTX에 한 번만 묻는다.
   시청자 수 = WebRTC 세션 + 활성 시청 세션(`POST /<path>/session`, 15 s 하트비트, 30 s 안 활성) + (대체) 세션 없는 HLS 클라이언트
   (주소+브라우저). 상한은 새 세션·새 WHEP에만 `503 + Retry-After`로 걸고 미디어 요청은 거절하지 않는다.

## 비교

| 기준 | WebRTC (WHEP, MediaMTX) | LL-HLS (MediaMTX, fMP4, 1 s 세그먼트·200 ms 파트) | 일반 HLS/CDN |
|---|---|---|---|
| 지연 | 1 s 미만 수준(설계상). 이 저장소의 로컬 측정은 첫 화면 시간만 있고 종단 지연은 미측정 | 수 초(설계상 2~4 s). 미측정 | 6~30 s |
| 1,000명 | 서버가 시청자마다 SRTP 암호화·UDP 송신. 1대 MediaMTX의 1,000 세션 한계는 미측정 | HTTP. 같은 세그먼트를 여러 명이 받음. MediaMTX가 직접 서빙하면 송신량은 같음 | CDN이 송신을 대신함(비용·약관 별도) |
| 모바일 | iOS Safari·Android Chrome 모두 WebRTC H.264/Opus 지원(실기기 미검증) | Safari 기본 HLS. Opus-in-fMP4 HLS는 iOS 지원이 불확실해 AAC 변환 경로를 따로 둠 | 같음 |
| ABR | 화질별 경로를 시청자가 골라 WHEP 세션을 바꿈(UI 쪽 자동 화질이 담당) | `live.m3u8`(화질별 AAC 그룹, 실측 AVERAGE-BANDWIDTH)로 hls.js ABR + 왕복 방지(2026-11-02 구현) | master playlist로 표준 ABR |
| DVR | 별도(녹화 + MSE 조각). iPhone Safari는 MSE가 없어 UI DVR 불가였음 | 라이브 창(7 s) + 방송 전체 `dvr.m3u8`(HLS EVENT, 2026-11-02 구현) | 긴 창 가능 |
| 방화벽 | UDP 8189 → TCP 8189 → (필요 시) TURN TLS 443 | HTTPS 443만 필요 | 443 |
| 서버 CPU | 세션당 암호화 비용 | 낮음(리먹스만) | 낮음 |
| 구현 상태 | 동작(로컬 측정). 브라우저 기본 경로에서는 제외 | **브라우저 기본 경로**(로컬 e2e: hls.js 재생·화질 전환·DVR) | CDN 규칙만 문서화, 미검증 |

송신량은 프로토콜보다 비트레이트가 결정한다. 8 Mbps × 1,000명 = 8 Gbps, 1시간 약 3.6 TB(영상 데이터만, 오버헤드·TURN 중계·
엣지 간 전송 제외). 3.5 Mbps(720p) 위주로 보면 3.5 Gbps, 약 1.6 TB/h다. WebRTC 미디어는 일반 HTTP CDN에 캐시되지 않는다.

## 왜 이 조합인가

- 기존 앱과 UI가 이미 WHEP·MediaMTX·MSE DVR로 동작한다. 같은 API를 중계 서버에 그대로 두면 UI를 다시 만들지 않고 인터넷
  시청을 붙일 수 있다(2026-10-28 작업의 Node 중계 relay.mjs는 UI를 한 줄도 바꾸지 않았다).
- (이전 결정, 2026-10-28) 낮은 지연을 이유로 HLS를 대체 경로로만 두었다. 2026-11-02 리드 결정으로 바뀌었다: 1,000명·모바일·
  CDN·DVR을 한 방식으로 묶는 것이 지연 1~2 s 차이보다 중요하다고 보고 일반 시청은 LL-HLS로, WebRTC는 데스크톱 앱의 초저지연
  확인용으로 남겼다(송출 앱 → 중계 업로드 구조는 그대로).
- 녹화를 `<path>/rec`(영상 + AAC)로 옮긴 이유: HLS 플레이어(hls.js, Safari)가 쓰는 트랙만 남기면 녹화 파일의 init을 그대로
  EXT-X-MAP으로 쓸 수 있고, Opus(브라우저 HLS에서 지원이 고르지 않음)를 다시보기에서 뺄 수 있다. 두 번째 인코딩은 없다(복사).
- 원본 1회 업로드 + 중계 서버 복제는 송출 PC 업로드 한계(시청자 수 × 비트레이트)를 없앤다. 송출 PC가 모든 시청자에게 직접
  보내는 기존 구조는 인터넷 시청에 쓰지 않는다.
- 화질별 공유 인코더는 시청자 수와 무관하게 인코더 수를 화질 수로 묶는다. 한 시청자의 회선이 느려도 원본이나 다른 시청자의
  화질은 바뀌지 않는다.
- 전달은 로컬 MediaMTX에서 읽는 별도 FFmpeg(복사)라 원본 인코딩·로컬 시청과 분리된다: 중계 서버가 끊겨도 로컬 시청은
  계속되고, 앱이 FFmpeg를 다시 띄워 재연결한다(e2e: 중계 MediaMTX 재시작 후 자동 복구). MediaMTX `forward`도 가능하지만
  로컬 API가 비밀번호가 든 주소를 그대로 돌려주므로 앱 방식(명령줄 노출)과 비교해 앱 담당이 고른다.
- 송출 PC 계정은 PC마다 하나이고 자기 경로에만 송출할 수 있다. 등록 토큰도 자기 경로만 쓴다. 공유 계정 하나였다면 한 PC의
  비밀번호로 다른 PC가 재연결하는 사이 그 경로를 가로챌 수 있었다.
- 영상이 잠깐 끊겨도(송출 재연결, 중계 재시작) 등록이 살아 있으면 `/info`는 `running:true, mediaReady:false`를 유지한다.
  MediaMTX API가 느리면 마지막 정상 목록을 유지한다. 둘 다 "송출 종료"가 모든 시청자에게 잘못 퍼지는 것을 막는다.

## 남은 위험과 다음 측정

- 1대 중계 서버의 WebRTC 세션 한계, 메모리·CPU 증가: 실제 미디어를 받는 부하 발생기로 1→10→50→100→300→500→1,000 단계
  측정이 필요하다(별도 담당 영역). 로컬 루프백 결과를 인터넷 1,000명으로 외삽하지 않는다.
- iPhone: WebRTC 실기기, Opus HLS 재생 여부, AAC LL-HLS의 파트 길이 경고(MediaMTX가 "iOS 클라이언트 오류 가능"이라고 기록,
  로컬에서 관찰됨), DVR(MSE 없음 → ManagedMediaSource 대응 필요) 모두 미검증이다.
- 멀티 화질 HLS(`live.m3u8`)와 쿠키 없는 HLS 중계는 구현했지만(로컬 e2e), 실제 CDN 앞단·LL-HLS 블로킹 요청의 CDN 처리·
  CDN 뒤 시청자 집계는 미검증이다. 화질 사이 타임라인은 화질 래더(결정 3)로 맞췄다(relay e2e 2026-11-02 14:46: 원본·480p
  PDT 차이 0 ms, 480p 전환 1.08 s 뒤 멈춤 없음 — 이전 실행의 3 s 멈춤 해소. 다만 2026-11-10에 전환 직후의 멈춤이 두 백엔드 모두에서
  간헐적으로 다시 나왔고 원인 미확인이다: `../verification/spring/RESULTS.md`). 래더를 유휴로 멈춘 뒤 첫 시청자는 약 8 s 기다린다.
- AAC 없이 올리는 이전 버전 송출: HLS 음성은 relay의 AAC 변환 경로(원본 화질 하나만), 녹화는 영상만.
- 6시간 넘는 방송: MediaMTX 보존(6 h)이 앞 파일을 지우면 dvr.m3u8은 EVENT가 아니게 되고 MEDIA-SEQUENCE로 이어진다(코드만, 미측정).
  EXT-X-SKIP(재생 목록 델타)이 없어 긴 방송의 dvr.m3u8은 계속 커진다(6 h ≈ 5,400 세그먼트).
- TURN은 예시 설정과 자격 증명 발급만 구현했고 실제 TURN 서버로는 검증하지 않았다.
