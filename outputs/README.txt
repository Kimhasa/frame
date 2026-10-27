FRAME Console UI 0.5

작업 루트: C:\Users\wlsdu\OneDrive\Desktop\frame
UI_HANDOFF.txt와 CLAUDE_FUNCTIONAL_TASKS.txt를 먼저 읽으십시오.
이 파일은 UI 소스입니다. 기존 C++ 구현은 native/에 보존되어 있으며 기존 dist/ exe를 이번 UI 작업에서 재빌드하지 않았습니다.

UI 빌드: node work/build-console.mjs
UI 기준 확인: node tools/verify-ui-v05.mjs
현재 기준: reference-v05/와 UI_V05_LOCK.json
이전 기준: reference/와 UI_LOCK.json (보존)

영상 목록·검색·수동 연결·프로그램/모니터 선택·넓은 플레이어·영상 정보 모달·채팅 패널·탐색 컨트롤을 추가했습니다. 기존 네이티브 브리지와 WHEP 수신 코드를 보존했습니다.
송출자도 오른쪽 채팅을 볼 수 있고 영상·오디오·시청 주소는 시작 버튼 왼쪽의 송출 설정 모달에 있습니다. 송출/수신 채팅의 방·메시지·초안·전송 확인을 분리했습니다. 실제 채팅 서버는 아직 연결하지 않았습니다.
실제 목록 등록 서버, 모니터 캡처, 방송 전체 DVR, 저장 최적화와 채팅 서버는 Claude가 연결해야 합니다. PiP와 클릭 재생·일시정지는 실제 video가 연결된 환경에서 최종 검증해야 합니다.
프레임 자동 비트레이트의 현재 계산은 UI 프리셋이며 높은 FPS 달성이나 실제 성능을 증명하지 않습니다.

Pretendard는 assets/fonts/의 로컬 파일을 사용합니다. OFL.txt와 SOURCE.txt를 포함해 배포하십시오. 외부 CDN은 사용하지 않습니다.
Codex의 localhost UI 검토용 예시 데이터는 이 프로젝트와 운영 HTML에 포함되어 있지 않습니다.
