FRAME 전체 기능 시안 검토 · 2026-10-29

프로젝트: C:\Users\wlsdu\OneDrive\Desktop\frame
디자인: design\2026-10-28
전체 검토 보드: http://127.0.0.1:5328/review-all.html
사용자 시안: http://127.0.0.1:5328/index.html?screen=live
검토 도구가 필요한 경우에만 주소에 &review=1 추가

2026-10-29 동작 명칭 추가 검토
팔로우 / 팔로우 취소 등 최신 동작 문구는 현재 실행 시안과 TERMINOLOGY.txt v2에 반영되어 있다.
ACTION_TERMS_REVIEW.txt와 verification/action-terms/의 추가 검증·이미지를 함께 확인한다.
아래 전체 검수 캡처는 해당 검수 시점의 기록으로 보존한다. 추가 문구 변경 후 모든 캡처를 다시 촬영한 것으로 해석하지 않는다.

이번 작업 범위
기능 정의 150개를 소스와 대조하고, 기존 58개 화면의 정의 상태 150개를 검토했다.
PC·모바일 캡처와 폼·선택·확인·취소·복귀의 브라우저 조작 기록을 분리해 보존한다.
단순 표시 검사만으로 모든 사용 흐름이 검증되었다고 처리하지 않는다.

정의 대조 결과
직접적인 입력·조작 흐름이 표현된 기능 55개
핵심 세부 화면이 부족하여 추가 설계가 필요한 기능 35개
실제 서버·회선·미디어·실기기·성능 시험이 중심인 기능 60개
위 분류는 기능 구현 완료율이나 디자인 승인율이 아니다.
개별 수락 기준과 남은 범위: verification/full-review/feature-scope-audit.json

주요 반영
반복 설명과 장식선, 가짜 페이지 번호, 동작 없는 탭을 정리했다.
시청 목록·팔로우·알림·시청 기록의 조작 결과를 메모리 시안에 반영했다.
방송자·관리·운영 메뉴 맥락과 공유 모달 닫기/초점 복귀를 정리했다.
폼 오류·초안·중복 제출 방지·처리 중·완료·취소 흐름을 보완했다.
모바일 표의 항목명과 카드 배치, 차트 날짜, 입력/버튼 끝선, 자체 선택 메뉴를 정리했다.
보상 모달 그리드 충돌, 오디오 아이콘 크기, 모바일 채팅 버튼 가림을 수정했다.
검토용 런처는 일반 시안에서 숨긴다.

검증 자료
verification/full-review/responsive-checks.json : 화면 폭별 표시·넘침·이름·ID 검사
verification/full-review/*browser-flows.json : 담당 영역별 실제 로컬 브라우저 조작
verification/full-review/visual-review-*.json : 실제 이미지 확인 및 수정 후 확인
verification/full-review/captures.json + screens/ : 정의 상태별 PC·모바일 이미지
verification/full-review/summary.json : 최종 집계와 원본 보존 검사

경계
시안 상의 계정·기기·결제·포인트·예약·신고·클립·키 등은 로컬 예시 상태다.
실제 인증·결제·세션 회수·기기 연결·인코딩·성능 시험을 이번 작업에서 구현하거나 통과했다고 보고하지 않는다.
모바일 검수는 브라우저 화면 크기와 DOM 조작 기준이다. 실제 휴대폰의 키보드·미디어 API·통신망 검증은 별도다.
일부 키보드 검사는 DOM 키 이벤트와 처리기 확인이며 OS 키 입력 시험과 구분한다.
플레이어·화질 제어 원본과 실제 앱/C++/서버 코드는 유지한다.

재생성
최신 캡처와 보고서를 유지한 상태에서 node prepare-full-review.mjs
보드만 다시 만드는 경우 node build-full-review.mjs
이전 prepare-v32*.mjs 또는 build-design.mjs를 실행해 최신 캡처와 로더를 되돌리지 않는다.
이전 검증 결과와 archive-before-full-review-2026-10-29는 비교 기록으로 보존한다.
