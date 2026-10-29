import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const backlog = JSON.parse(fs.readFileSync(path.join(root, 'backlog-snapshot.json'), 'utf8').replace(/^\uFEFF/, ''));
const screens = [];
function screen(id, group, name, priority, kind, states, features) {
  screens.push({ id, group, name, priority, kind, states: states.split('|'), features: features.split(/\s+/).filter(Boolean) });
}
const ids = (prefix, from, to) => Array.from({length:to-from+1}, (_,i)=>`${prefix}-${String(i+from).padStart(2,'0')}`).join(' ');
screen('live','시청','라이브','P0','상세','기본|불러오는 중|방송 없음|불러오기 실패', 'NET-06 NET-07 NET-12 CHANNEL-07 MOB-03 MOB-04 MOB-05');
screen('watch','시청','방송 시청','P0','상세','기본|일시정지|지난 구간|재연결 중|방송 종료|재생 실패|접속자 많음|소리 켜기', `${ids('PLAYER',1,10)} ${ids('ABR',1,12)} ${ids('MOB',1,12)} CONTENT-01 CONTENT-07 CONTENT-08 CHAT-01 CHAT-03 CHAT-10 CHAT-12 CAST-11`);
screen('following','시청','팔로잉','P1','기본 구조','기본|팔로우 없음|로그인 필요','CHANNEL-03 CHANNEL-04');
screen('search','시청','검색 결과','P2','기본 구조','기본|검색 결과 없음','CHANNEL-07');
screen('channel','시청','채널','P1','기본 구조','방송 중|오프라인|접근 제한','CHANNEL-01 CHANNEL-02 CHANNEL-03 CHANNEL-06 CHANNEL-09 AUTH-08');
screen('vod','시청','다시보기 목록','P2','기본 구조','기본|다시보기 없음','CONTENT-04 CONTENT-09 CONTENT-10');
screen('vod-watch','시청','다시보기 재생','P2','기본 구조','기본|재생 실패|삭제된 영상','CONTENT-04 CONTENT-06 CONTENT-07 CONTENT-08 CONTENT-10 PLAYER-09 PLAYER-10');
screen('clips','시청','클립 목록','P2','기본 구조','기본|클립 없음','CONTENT-05');
screen('clip-watch','시청','클립 재생','P2','기본 구조','기본|삭제된 영상','CONTENT-05 EXT-05');
screen('history','시청','시청 기록','P2','기본 구조','기본|기록 없음','CHANNEL-10 AUTH-10');
screen('notifications','시청','알림','P1','기본 구조','기본|알림 없음','CHANNEL-04');
screen('studio','방송','방송하기','P0','상세','방송 전|방송 중|화면 연결 끊김|방송 연결 실패','CAST-04 CAST-06 CAST-07 CAST-08 CAST-09 CAST-10 CAST-11 CHAT-01 CHAT-03 NET-02 NET-08');
screen('sources','방송','공유할 화면','P0','상세','프로그램 창|전체 화면|불러오는 중|응답 지연|창 닫힘|대상 없음','CAST-01 CAST-02 CAST-03 CAST-05');
screen('broadcast-settings','방송','방송 설정','P0','상세','기본|수동 비트레이트|지원 범위 오류','CAST-06 CAST-07 CAST-08 CAST-09 CAST-10');
screen('connection','방송','연결 설정','P0','상세','기본|연결 확인 중|연결 실패','NET-01 NET-02 NET-05 NET-08 NET-11 EXT-01');
screen('broadcast-details','방송','방송 정보 수정','P1','기본 구조','기본|입력 오류','CHANNEL-05');
screen('broadcast-end','방송','방송 종료','P0','상세','종료 확인|종료 요약','CONTENT-02 CONTENT-03 OPS-05');
screen('recordings','방송','녹화 관리','P1','기본 구조','기본|저장 공간 부족|녹화 없음','CONTENT-02 CONTENT-03 CONTENT-09');
screen('schedule','방송','방송 예약','P2','기본 구조','기본|예약 없음','CHANNEL-06');
screen('scenes','방송','장면 관리','P2','기본 구조','기본|장면 없음','CAST-12 EXT-02');
screen('login','계정','로그인','P1','기본 구조','기본|연동 실패|동의 필요','AUTH-01 AUTH-03 AUTH-04 AUTH-06');
screen('profile','계정','내 프로필','P1','기본 구조','기본|닉네임 오류','AUTH-02 AUTH-05');
screen('security','계정','계정 및 보안','P1','기본 구조','기본|재인증 필요','AUTH-03 AUTH-04 AUTH-05 AUTH-06 AUTH-09 AUTH-10');
screen('preferences','계정','설정','P1','기본 구조','기본|알림 차단','CHANNEL-04 EXT-07 AUTH-10');
screen('channel-edit','관리','채널 관리','P1','기본 구조','기본|저장 오류','CHANNEL-01 CHANNEL-02 CHANNEL-05 CHANNEL-09 AUTH-07 AUTH-08');
screen('moderation','관리','채팅 관리','P1','기본 구조','기본|운영자 없음','CHAT-04 CHAT-05 CHAT-06 CHAT-07 CHAT-08 CHAT-10 CHAT-11 CHAT-12 AUTH-07');
screen('reports','관리','신고 관리','P1','기본 구조','기본|신고 없음','CHAT-09');
screen('creator-stats','관리','방송 통계','P2','기본 구조','기본|데이터 없음','OPS-05 OPS-06');
screen('revenue','관리','수익 및 정산','P2','기본 구조','기본|정산 대기','PAY-04 PAY-11 PAY-12 OPS-07');
screen('transactions','계정','결제 내역','P2','기본 구조','기본|환불 요청|내역 없음','PAY-02 PAY-03');
screen('integrations','관리','외부 도구 연결','P2','기본 구조','기본|연결 없음','EXT-01 EXT-02 EXT-03 EXT-04');
screen('missions-manage','관리','미션 관리','P2','기본 구조','기본|미션 없음','ENGAGE-03 PAY-09 PAY-10 ENGAGE-08');
screen('polls-manage','관리','투표 및 질문 관리','P2','기본 구조','기본|진행 중 없음','ENGAGE-01 ENGAGE-02 ENGAGE-06');
screen('rewards-manage','관리','포인트 및 보상 관리','P2','기본 구조','기본|보상 없음','ENGAGE-04 ENGAGE-05 ENGAGE-07 ENGAGE-10');
screen('members','관리','멤버십 관리','P2','기본 구조','기본|가입자 없음','PAY-07 PAY-08');
screen('donate','참여','후원하기','P2','기본 구조','금액 선택|처리 중|완료|결제 실패','PAY-01 PAY-02 PAY-03 PAY-05 PAY-06 PAY-11');
screen('membership','참여','멤버십 가입','P2','기본 구조','기본|가입 완료|결제 실패','PAY-07 PAY-08');
screen('mission','참여','미션 제안','P3','기본 구조','기본|진행 중|완료|실패','PAY-09 PAY-10 ENGAGE-03');
screen('poll','참여','투표 및 질문','P2','기본 구조','기본|투표 완료|마감','ENGAGE-01 ENGAGE-02 ENGAGE-06');
screen('rewards','참여','포인트 보상','P2','기본 구조','기본|포인트 부족|교환 완료','ENGAGE-04 ENGAGE-05 ENGAGE-07 ENGAGE-08 ENGAGE-10');
screen('share','공통','방송 링크 공유','P0','상세','기본|복사 완료','NET-01 NET-07 EXT-05');
screen('info','공통','방송 정보','P0','상세','기본','PLAYER-07 OPS-01');
screen('quality','공통','화질 선택','P0','기존 유지','자동|수동|전환 중',`${ids('ABR',1,12)} MOB-12`);
screen('nickname','공통','닉네임 설정','P0','상세','기본|입력 오류','CHAT-02 AUTH-02');
screen('manual','공통','직접 연결','P0','상세','기본|연결 중|연결 실패','NET-01 NET-04 NET-05 NET-07');
screen('report-content','공통','신고하기','P1','기본 구조','기본|접수 완료','CHAT-09 OPS-08 OPS-10');
screen('clip-create','공통','클립 만들기','P2','기본 구조','기본|처리 중|생성 완료','CONTENT-05 CONTENT-06');
screen('service-health','운영','서비스 상태','P0','기본 구조','기본|과부하|장애','OPS-01 OPS-02 PERF-01 PERF-03 PERF-09 NET-09 NET-10');
screen('service-reports','운영','서비스 신고 관리','P1','기본 구조','기본|신고 없음','OPS-08 OPS-10 CHAT-09');
screen('audit','운영','활동 기록','P1','기본 구조','기본|기록 없음','OPS-09 OPS-03 AUTH-10');
screen('policy','공통','이용 및 콘텐츠 정책','P2','기본 구조','기본','OPS-10 AUTH-10');
screen('update','공통','앱 업데이트','P1','기본 구조','업데이트 있음|다운로드 중|최신 버전','EXT-06');
screen('devices','공통','다른 기기에서 보기','P3','기본 구조','기본|기기 없음|연결 실패','EXT-08');
screen('recommendations','시청','추천 방송','P3','기본 구조','기본|추천 없음','CHANNEL-08');
screen('raid','참여','다른 방송으로 연결','P3','기본 구조','방송 선택|이동 확인|완료','ENGAGE-09');
screen('drop-rewards','참여','시청 보상','P3','기본 구조','기본|수령 가능|수령 완료','ENGAGE-10');
screen('developer','관리','개발자 설정','P2','기본 구조','기본|키 발급 확인','EXT-04 OPS-03');
screen('verification','검증','화면 없는 기능 검증','P0','검증 항목','기본',`${ids('PERF',1,10)} NET-02 NET-03 NET-04 NET-05 NET-09 NET-10 NET-11 OPS-03 OPS-04 CAST-07`);
const terms = [
 ['송출 하기 / 송출하기','방송하기','메뉴','방송 화면으로 이동하는 탐색 항목'],
 ['전체 수신 목록 / 실시간 영상','라이브','메뉴','현재 진행 중인 방송 목록'],
 ['송출 시작','방송 시작','버튼','메뉴의 방송하기와 시작 동작을 구분'],
 ['송출 종료 / 송출 중지','방송 종료','버튼','시청 일시정지와 다른 방송자 동작'],
 ['송출 설정','방송 설정','모달','화면·오디오·출력 설정을 한 곳에 모음'],
 ['송출명 / 스트림 이름(제목 의미)','방송 제목','입력·정보','기술 식별자인 스트림 ID와 구분'],
 ['송출자 / 수신자','방송자 / 시청자','역할','기술 로그와 API 내부 이름은 유지 가능'],
 ['송출 대상 선택','공유할 화면','모달 제목','선택만으로 방송을 시작하지 않음'],
 ['창 선택 / 대상 변경','화면 선택','버튼','현재 공유 대상을 고르는 동작'],
 ['애플리케이션 / 프로그램','프로그램 창','탭','전체 화면 탭과 같은 수준'],
 ['모니터 공유','전체 화면','탭','카드에는 모니터 번호·해상도·주 모니터 표시'],
 ['영상 정보','방송 정보','버튼·모달','항상 펼친 설명 영역을 추가하지 않음'],
 ['시청 주소 / 수신 주소','방송 링크','공유','외부에서 시청하는 주소'],
 ['수동 연결','직접 연결','고급 동작','서버 주소·포트를 직접 지정'],
 ['화면 속 화면 / PiP / PIP','PIP 모드','도구 설명','대소문자까지 같은 표기 사용'],
 ['채팅 이름 / 표시 이름','닉네임','입력','계정 식별자와 채팅 표시 이름은 구분'],
 ['화질 auto / 자동 화질','자동','화질 메뉴','현재 적용 화질을 자동 (1080p)처럼 함께 표시'],
 ['실시간 / LIVE / 라이브 혼용','라이브','배지·플레이어','복귀 버튼 툴팁은 실시간으로 이동'],
 ['되감기 / DVR(기능 이름)','지난 구간 보기','설명·접근성','방송 중 과거 구간 탐색; 버튼은 재생바로 제공'],
 ['방송 종료 후 녹화 영상','다시보기','콘텐츠','방송 중 지난 구간 보기와 구분'],
 ['녹화 파일','녹화 파일','방송자 관리','로컬 파일이 공개 다시보기인 것으로 표시하지 않음'],
 ['도네이션 / 도네','후원','메뉴·버튼','버튼은 후원하기'],
 ['무료 구독 / 즐겨찾는 채널','팔로우','버튼','무료 관심 등록'],
 ['유료 구독 / 정기 구독','멤버십','메뉴·버튼','유료 가입; 버튼은 멤버십 가입'],
 ['채널 포인트 / 시청 포인트','포인트','참여','잔액·획득·사용을 같은 단위로 표시'],
 ['미션 도네 / 도전 후원','미션 후원','참여','무료 미션과 금액·결제 유무로 구분'],
 ['채팅 관리자','채팅 운영자','역할','서비스 관리자와 권한 범위를 구분'],
 ['슬로 모드','느린 채팅','설정','전송 간격을 초 단위로 표시'],
 ['뮤트(재생)','음소거','플레이어','방송자 마이크 설정의 마이크 끄기와 구분'],
 ['전체화면 / 전체 화면','전체 화면','버튼','브라우저 전체 화면과 캡처 탭은 문맥으로 구분'],
 ['확대 모드 / 극장 모드','확대 보기','버튼','명시적으로 선택했을 때만 좌측 메뉴 축소'],
 ['리프레시 / 갱신','새로고침','도구 설명','아이콘 버튼에는 목록 새로고침 접근성 이름'],
 ['접속자 수 / 연결 수(시청자 의미)','시청자 수','정보','실제 시청 세션 기준; 서버 연결 수와 구분'],
 ['프레임','프레임률','방송 설정','단위는 fps; 실제 FPS와 목표 프레임률 구분'],
 ['영상 품질 / 영상 화질 혼용','화질','시청 설정','방송 출력 설정의 해상도·비트레이트와 구분'],
 ['오디오 소스','오디오','설정','세부 항목은 시스템 소리·마이크'],
 ['출력 볼륨 / 수신 볼륨','음량','플레이어','값은 0~100%'],
 ['OAuth / OIDC(기본 화면)','로그인','계정','제공자 이름은 실제 지원이 정해진 뒤 추가'],
 ['호스트 / endpoint(기본 화면)','서버 주소','연결 설정','서버 IP·호스트 이름 입력을 지원'],
 ['스트림 경로 / path','스트림 ID','고급 설정','방송 제목·방송 링크와 구분'],
 ['상태 뱃지 대기 / 준비됨','표시하지 않음','시작 버튼 주변','반복 상태 문구를 버튼 옆에 추가하지 않음'],
 ['내부망 / 폐쇄망','표시하지 않음','환경 배지','접속 환경으로 제품의 이용 범위를 제한하지 않음']
].map(([before,after,where,rule])=>({before,after,where,rule}));
const missing=backlog.filter(f=>!screens.some(s=>s.features.includes(f.ID)));
if(missing.length)throw new Error('Unmapped features: '+missing.map(f=>f.ID));
const known=new Set(backlog.map(f=>f.ID));
const unknown=screens.flatMap(s=>s.features).filter(id=>!known.has(id));
if(unknown.length)throw new Error('Unknown feature IDs: '+unknown);
const data={version:'1.1',date:'2026-10-28',protectedRegions:['기존 영상 플레이어','화질 메뉴와 자동·수동 화질 동작','음량·음소거','재생·일시정지','DVR 재생바·실시간 복귀','PIP·전체 화면·확대 보기','캡처·인코딩·전송과 비트레이트 계산'],references:[{name:'치지직',url:'https://chzzk.naver.com/',scope:'라이브 목록·탐색·팔로잉·채널 진입 구조'},{name:'YouTube Live',url:'https://support.google.com/youtube/answer/15270973?hl=ko',scope:'라이브·채팅·멤버십·다시보기의 서비스 흐름'},{name:'SOOP',url:'https://www.sooplive.com/',scope:'LIVE·탐색·MY·알림·검색의 탐색 구조'}],screens,terms,features:backlog.map(f=>({id:f.ID,category:f['분류'],name:f['기능'],priority:f['우선순위'],baselineStatus:f['현재상태'],acceptance:f['완료기준'],screens:screens.filter(s=>s.features.includes(f.ID)).map(s=>s.id)}))};
fs.writeFileSync(path.join(root,'design-manifest.json'),JSON.stringify(data,null,2));
fs.writeFileSync(path.join(root,'dist','design-data.js'),'window.FRAME_DESIGN_DATA = '+JSON.stringify(data)+';\n');
const doc=['FRAME 화면 설계 목록 v1','작성일: 2026-10-28','','범위: 기능 백로그 150개를 화면·모달·공통 상태·화면 없는 검증 항목으로 연결한 시안. 실제 캡처·송출·인증·결제 구현이 아니다. 기존 기능 우선순위는 보존하고 시안 작성 순서를 별도로 관리한다.','','시안 수준: 상세 = 시청·방송 핵심 화면과 모달의 배치·입력·상태를 상세 설계. 기본 구조 = 후속 기능의 화면 흐름과 필드·표·확인 상태를 정리한 1차 시안. 검증 항목 = 일반 사용자 메뉴에 노출하지 않는 기술 검증.','','화면 수: '+screens.length+' / 기능 연결: '+backlog.length+' / 용어 규칙: '+terms.length,'',...screens.flatMap(s=>[`${s.id} | ${s.group} | ${s.name} | ${s.priority} | ${s.kind}`,`상태: ${s.states.join(' / ')}`,`기능: ${s.features.join(', ')}`,'']),'기능별 역추적','',...data.features.map(f=>`${f.id} | ${f.priority} | ${f.name} → ${f.screens.join(', ')}`)];
fs.writeFileSync(path.join(root,'SCREEN_INVENTORY.txt'),doc.join('\n'));
fs.writeFileSync(path.join(root,'TERMINOLOGY.txt'),['FRAME 제품 용어 기준 v1','작성일: 2026-10-28','','적용 대상: 새 화면 문구, 버튼, 모달, 툴팁, 접근성 이름, 오류 메시지. 기존 영상 플레이어·화질 제어의 문구와 모양은 최신 사용자 지시에 따라 유지하며 아래 통일 표현의 일괄 적용 대상에서 제외한다. 내부 변수·API·프로토콜 이름을 문자열 일괄 치환하지 않는다.','','문체: 메뉴는 짧은 명사 또는 방송하기. 동작은 시작·종료·선택·저장·취소. 오류는 짧은 해요체, 복구 동작은 명확한 버튼. 같은 대상을 방송/스트림/영상으로 임의 교체하지 않는다. 방송 제목, 스트림 ID, 방송 링크는 각각 다른 값이다.','',...terms.flatMap(t=>[`${t.before} → ${t.after}`,`위치: ${t.where} / 기준: ${t.rule}`,''])].join('\n'));
console.log(JSON.stringify({screens:screens.length,features:backlog.length,terms:terms.length,unmapped:missing.length}));

