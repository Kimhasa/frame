# 제품 API

같은 Spring Boot 프로세스의 `/api/v1/*`가 제품 API다. PostgreSQL에는 계정·채널 프로필·주소 예약·신고·팔로우·방송 예약·시청 기록·알림·채팅 정책·투표·질문과 답변·비현금 포인트와 보상·무료 미션과 상태 이력을 저장하고, Redis에는 Spring Session 로그인 세션만 저장한다. SQL은 `JdbcClient`, 스키마 변경은 Flyway의 `db/migration/V*.sql`로 관리한다. 기본값은 비활성화이며 기존 중계·HLS·채팅·운영자 Bearer API는 이전 계약을 유지한다.

## 실행 설정

| 환경 변수 | 값·용도 |
| --- | --- |
| `FRAME_PRODUCT_ENABLED` | `true`로 제품 API·DB·Redis 연동 활성화. 기본 `false` |
| `FRAME_PRODUCT_DB_URL` | PostgreSQL JDBC URL. 로컬 전용 예: `jdbc:postgresql://127.0.0.1:15432/frame_product` |
| `FRAME_PRODUCT_DB_USERNAME`, `FRAME_PRODUCT_DB_PASSWORD` | FRAME 전용 DB 역할과 암호. 저장소 밖 비밀 설정에서 전달 |
| `FRAME_PRODUCT_REDIS_HOST`, `FRAME_PRODUCT_REDIS_PORT`, `FRAME_PRODUCT_REDIS_PASSWORD` | 인증된 Redis. 로컬 기본 주소 `127.0.0.1:16379` |
| `FRAME_PRODUCT_REDIS_NAMESPACE` | 기본 `frame:product:sessions`. 환경별 독립 namespace |
| `FRAME_PRODUCT_PUBLIC_ORIGIN` | 브라우저의 정확한 Origin. 로컬 기본 `http://127.0.0.1:5360`, 끝 `/` 없음 |
| `FRAME_PRODUCT_COOKIE_SECURE` | HTTPS에서는 반드시 `true`. HTTP는 루프백 개발 환경에서만 허용 |

운영 DB에는 가상 사용자나 채널을 초기 데이터로 넣지 않는다. 최초 가입은 새 사용자와 그 사용자의 채널 하나를 트랜잭션으로 생성한다. 기존 OBS 경로를 첫 가입자에게 자동 배정하지 않는다. 제품 기능 비활성 시 JDBC·Flyway·Redis·Session·Security 자동 설정을 가져오지 않으므로 기존 미디어 실행에 DB나 Redis가 필요하지 않다.

## 인증·응답

브라우저는 같은 출처에서 쿠키를 포함해 요청한다. 최초 `GET /api/v1/session`으로 세션과 `csrfToken`을 얻고, 모든 쓰기 요청에 `X-CSRF-TOKEN` 헤더를 붙인다. 로그인·가입 성공은 세션 ID와 CSRF 토큰을 교체하므로 반환된 토큰으로 갱신한다. 로그아웃 후 다시 사용할 토큰은 `GET /api/v1/session`으로 얻는다.

쿠키 `FRAME_SESSION`은 `HttpOnly`, `SameSite=Lax`, `Path=/`, HTTPS에서 `Secure`다. 일반 로그인은 세션 쿠키와 최대 12시간, 로그인 유지 선택은 최대 30일과 같은 `Max-Age`를 사용한다. Redis 유휴 만료와 별도로 로그인 시각을 검사하여 요청을 계속 보내도 이 최대 기간을 늘리지 않는다. 서버 재시작 후에는 같은 Redis 세션으로 로그인 상태를 복원하며, 로그아웃은 기존 쿠키를 재사용해도 인증되지 않는다. 세션의 인증 주체는 내부 사용자 UUID와 역할이며 계정 객체·이메일·비밀번호 해시를 저장하지 않는다.

삭제된 계정을 가리키는 오래된 인증 세션은 `GET /api/v1/session`에서 401 `UNAUTHENTICATED`와 함께 폐기한다. 클라이언트의 한 번의 초기화 재시도는 새 익명 세션·CSRF를 받는다. 정상 계정의 세션이나 일시적인 503 오류는 이 처리로 로그아웃시키지 않는다. 정책 API는 인증 여부와 관계없이 공개다.

비밀번호는 Spring Security의 PBKDF2와 임의 salt로 해시한다. 원문을 저장·로그·응답에 넣지 않는다. 이메일은 소문자로 정규화하며 DB 고유 제약으로 동시 가입 중복도 거절한다. 가입·로그인·송출 연결에는 요청 제한을 적용한다. 제품 API는 미디어 API의 CORS `*` 설정을 사용하지 않으며, 다른 Origin의 요청을 거절한다.

Spring Session 필터 자체도 `/api/v1/*`에만 등록한다. 로그인 쿠키가 포함되어도 기존 HLS·채팅·방송 목록·`/healthz` 요청은 제품 Redis 세션을 읽거나 저장하지 않는다. Redis 연결·명령 기한은 각각 2초이며, 제품 API에서 Redis 조회 또는 응답 직전 세션 저장에 실패하면 503 `PRODUCT_UNAVAILABLE`로 응답한다. 비로그인 CSRF 세션을 저장할 수 없는 상황도 로그인 해제 성공이나 정상 초기 상태로 응답하지 않는다.

모든 응답은 `Cache-Control: no-store`다. 오류는 `application/problem+json`의 `{type:"about:blank",title,status,code,detail}`이며, 입력 원문·SQL 오류·비밀 값은 반환하지 않는다. 주요 코드는 `UNAUTHENTICATED`, `CSRF_INVALID`, `ORIGIN_FORBIDDEN`, `INVALID_CREDENTIALS`, `ACCOUNT_EXISTS`, `INVALID_INPUT`, `CHANNEL_NOT_FOUND`, `SELF_FOLLOW_NOT_ALLOWED`, `RATE_LIMITED`, `PRODUCT_UNAVAILABLE`다.

## 계약

`Session`은 `{user,channel,csrfToken}`이다. 비로그인 상태의 `user`와 `channel`은 명시적 `null`이다. 로그인한 `user`는 `{id,email,displayName,isOperator:boolean}`이고 `channel`은 아래 전체 `Channel` 객체다. `isOperator`는 현재 계정 DB 값이며 로그인 세션에 운영자 역할을 캐시하지 않는다.

`Channel`은 `{id,handle,displayName,description,notice,category,avatarUrl:null,bannerUrl:null,bannerPreset,followerCount,following,notificationsOn,liveBroadcast,createdAtMs,countryCode:null|string,links:[{title,url}],videoCount:null,totalViewCount:null}`다. 모든 필드는 항상 포함한다. `createdAtMs`는 기존 채널 행의 `created_at`을 epoch milliseconds로 반환하며 계정 가입일과 구분한다. 팔로워 수는 실제 팔로우 행을 세고, 팔로잉·알림 여부는 현재 사용자 기준이다. 비로그인 상태의 두 값은 `false`다. 실제 영상 카탈로그·누적 조회 집계가 없으므로 두 카운터는 명시적 `null`이며 개인 시청 기록으로 대신 계산하지 않는다. 이미지 업로드는 이번 단계에 없고 `bannerPreset`은 `null`, `studio`, `forest`, `city` 중 하나다. 새 채널의 `liveBroadcast`는 `null`이다.

| 요청 | 본문·결과 |
| --- | --- |
| `GET /api/v1/session` | 200 `Session`. 비로그인도 호출 가능 |
| `GET /api/v1/policies` | 공개 200 `{terms,privacy}`. 각 문서는 `{version,title,required:true,sections:[{heading,paragraphs:string[]}]}` |
| `POST /api/v1/auth/register` | `{email,password,displayName,handle?,termsAccepted:true,privacyAccepted:true,termsVersion,privacyVersion}` → 201 `Session`, 가입 즉시 로그인. 일반 가입 UI는 `handle` 생략 |
| `POST /api/v1/auth/login` | `{email,password,remember?:boolean}` → 200 `Session` |
| `POST /api/v1/auth/logout` | 204, 현재 세션 폐기. CSRF 필요 |
| `GET /api/v1/channels/{handle}` | 공개 200 `Channel`. 과거 주소도 같은 UUID를 조회하고 현재 `handle`을 반환, 없으면 404 |
| `GET /api/v1/channel-ids/{channelId}` | 공개 200 `Channel`. 변경되지 않는 UUID 공유 주소용, 잘못된 UUID 400·없으면 404 |
| `POST /api/v1/channels/{channelId}/reports` | 로그인 `{reason,details?}` → 201 `{id,status:'received',createdAtMs}`. 아래 신고 접수 규칙 |
| `GET /api/v1/admin/reports` | 운영자 200 `{items:Report[],nextCursor:null|string}`. 아래 상태·사유·검색·커서 조건 |
| `GET /api/v1/admin/reports/{id}` | 운영자 200 `ReportDetail`. 없으면 404 |
| `PATCH /api/v1/admin/reports/{id}` | 운영자 `{status,reviewNote,version}` → 200 `ReportDetail`. 아래 상태 전이·동시 수정 규칙 |
| `GET /api/v1/channels?query=&limit=50` | 200 `{items:Channel[],nextCursor:null}`. 검색어 최대 120자, 제어문자 금지, limit 1~50 |
| `GET /api/v1/me/follows` | 200 `{items:Channel[],nextCursor:null}`. 최대 200개 |
| `POST /api/v1/me/history` | `{broadcastId,path}` → 204. 현재 방송의 서버 메타데이터와 서버 시각을 본인 기록에 저장 |
| `GET /api/v1/me/history` | 200 `{userId,items:HistoryItem[],nextCursor:null|string}`. 아래 검색·기간·커서 조건 |
| `GET /api/v1/me/history/media/{kind}/{mediaId}` | 로그인 200 `{userId,item:null|HistoryItem,epoch,serverNowMs}`. kind는 vod/clip. 공개 재생 가능한 영상의 본인 저장 위치 읽기, 기록 생성 없음 |
| `PUT /api/v1/me/history/media/{kind}/{mediaId}` | `{epoch,id:null|uuid,version,positionMs,completed}` → 200 `{userId,item:HistoryItem,epoch,serverNowMs}`. 아래 위치·동시 탭·삭제 조건 |
| `DELETE /api/v1/me/history/{id}` | 204. 본인의 해당 기록 삭제, 없거나 타인 기록은 404 |
| `POST /api/v1/me/history/delete` | `{ids:uuid[1..200]}` → 204. 모든 ID가 본인 기록이어야 하며 하나라도 없으면 전체 404·삭제 안 함 |
| `DELETE /api/v1/me/history` | 204. 필터·페이지와 관계없이 본인 시청 기록 전체 삭제 |
| `GET /api/v1/me/notifications` | 200 `{userId,items:Notification[],nextCursor:null|string,unreadCount}`. 아래 필터·커서 조건 |
| `GET /api/v1/me/notifications/unread-count` | 200 `{userId,unreadCount}`. 본인 전체 미확인 수 |
| `PATCH /api/v1/me/notifications/{id}/read` | 본문 없음 → 200 `{userId,unreadCount}`. 본인 알림 확인, 반복해도 최초 확인 시각 유지 |
| `POST /api/v1/me/notifications/read-all` | 본문 없음 → 200 `{userId,unreadCount}`. 본인 전체 알림 확인 |
| `DELETE /api/v1/me/notifications/{id}` | 200 `{userId,unreadCount}`. 본인 알림 삭제, 없거나 타인 알림은 404 |
| `DELETE /api/v1/me/notifications` | 200 `{userId,unreadCount}`. 필터·페이지와 관계없이 본인 알림 전체 삭제 |
| `GET /api/v1/me/chat/settings` | 200 `ChatSettings`. 본인 채널의 채팅 정책 |
| `PATCH /api/v1/me/chat/settings` | `{version,slowMode,slowSeconds,followersOnly,blockLinks,bannedWords}` → 200 `ChatSettings` |
| `GET /api/v1/me/chat/blocks` | 200 `{userId,items:ChatBlock[],nextCursor:null|string}`. 아래 상태·검색·커서 조건 |
| `POST /api/v1/me/chat/blocks` | `{targetChannelId,durationSeconds:null|600|3600,reason}` → 201 `{userId,item:ChatBlock}` |
| `DELETE /api/v1/me/chat/blocks/{id}?version=N` | 200 `{userId}`. 본인 채널의 해당 차단 해제 |
| `POST /api/v1/chat/tickets` | 로그인·CSRF `{path,broadcastId}` → 200 `{ticket,expiresAtMs,userId,displayName}`. WebSocket join용 30초 일회 인증 |
| `GET /api/v1/me/polls` | 200 `{userId,items:Poll[],nextCursor,currentBroadcast,activePollId,serverNowMs}`. 아래 상태·검색·기간·커서 조건 |
| `GET /api/v1/me/polls/{id}` | 200 `{userId,poll:Poll,serverNowMs}`. 본인 채널의 결과 |
| `POST /api/v1/me/polls` | `{question,options:string[],durationSeconds,broadcastId,path}` → 201 `{userId,poll:Poll,serverNowMs}` |
| `POST /api/v1/me/polls/{id}/close` | `{version}` → 200 `{userId,poll:Poll,serverNowMs}`. 본인 채널 투표 수동 마감 |
| `GET /api/v1/polls/current?path=&broadcastId=` | 공개 200 `PollView`. 지정한 방송의 최신 투표·결과 |
| `POST /api/v1/polls/{id}/votes` | 로그인·CSRF `{optionId,broadcastId,path}` → 200 `PollView`. 본인 계정 한 표 |
| `GET /api/v1/me/questions` | 200 `{userId,items:Question[],nextCursor,currentBroadcast,pinnedQuestionId,serverNowMs}`. 본인 채널의 비공개 질문·답변 |
| `GET /api/v1/me/questions/{id}` | 200 `{userId,item:Question,serverNowMs}`. 본인 채널 질문 상세 |
| `PATCH /api/v1/me/questions/{id}` | `{version,answer?:string,pinned?:boolean}` → 200 `{userId,item:Question,serverNowMs}` |
| `GET /api/v1/questions/current?path=&broadcastId=` | 공개 200 `QuestionView`. 현재 공개 고정 질문과 로그인 본인의 질문 |
| `POST /api/v1/questions` | 로그인·CSRF `{path,broadcastId,text,clientRequestId:UUID}` → 새 질문 201, 동일 요청 재확인 200 `{userId,item:OwnQuestion,serverNowMs}` |
| `GET /api/v1/me/rewards` | 200 `{userId,items:Reward[],nextCursor,serverNowMs}`. 본인 채널의 활성·비활성 보상 |
| `GET /api/v1/me/rewards/{id}` | 200 `{userId,item:Reward,serverNowMs}` |
| `POST /api/v1/me/rewards` | `{name,points,limit,enabled,clientRequestId}` → 새 보상 201, 같은 요청 재확인 200 `{userId,item:Reward,serverNowMs}` |
| `PATCH /api/v1/me/rewards/{id}` | `{name,points,limit,enabled,version}` → 200 `{userId,item:Reward,serverNowMs}` |
| `GET /api/v1/rewards/current?path=&broadcastId=` | 공개 200 `RewardView`. 현재 보상과 로그인 본인의 잔액·신청 |
| `POST /api/v1/rewards/{id}/redemptions` | `{path,broadcastId,rewardVersion,note,clientRequestId}` → 새 신청 201, 같은 요청 재확인 200 `{userId,item:OwnRedemption,balance,serverNowMs}` |
| `GET /api/v1/me/redemptions` | 200 `{userId,items:Redemption[],nextCursor,serverNowMs}`. 본인 채널 교환 요청 |
| `GET /api/v1/me/redemptions/{id}` | 200 `{userId,item:Redemption,serverNowMs}` |
| `PATCH /api/v1/me/redemptions/{id}` | `{version,status,reason}` → 200 `{userId,item:Redemption,serverNowMs}`. 상태 변경·필요 시 한 번 환불 |
| `POST /api/v1/redemptions/{id}/cancel` | 신청자 `{version}` → 200 `{userId,item:OwnRedemption,balance,serverNowMs}`. 대기 신청만 취소 |
| `GET /api/v1/me/points?channelId=` | 로그인 200 `{userId,channelId,balance,items:Ledger[],nextCursor,serverNowMs}`. 본인 채널별 잔액·원장 |
| `POST /api/v1/points/watch` | 로그인 `{path,broadcastId,viewerSessionId,visitId,sequence,eligibleMs,watching}` → 200 `WatchPoints` |
| `PUT /api/v1/me/follows/{channelId}` | `{notificationsOn?:boolean}` → 200 `Channel`. 생략하면 기존 알림 유지, 새 팔로우는 알림 끔. 반복 호출에도 관계 하나 |
| `DELETE /api/v1/me/follows/{channelId}` | 200 `Channel`. 반복 호출에도 팔로우 해제 상태 |
| `PATCH /api/v1/me/profile` | `{displayName}` → 200 `Session`. 계정 표시 이름만 변경 |
| `PATCH /api/v1/me/channel` | `{displayName,description,notice,category,bannerPreset?,handle?,countryCode?,links?}` → 200 `Channel`. 세션 소유자의 채널만 변경, 생략한 새 선택 필드는 기존 값 유지 |
| `GET /api/v1/me/schedules` | `{items:[{id,title,at}]}`. 본인 채널의 가까운 미래 100건·최근 과거 100건 |
| `POST /api/v1/me/schedules` | `{title,at}` → 201 `{id,title,at}`. 본인 채널에 방송 예약 추가 |
| `PATCH /api/v1/me/schedules/{id}` | `{title,at}` → 200 `{id,title,at}`. 본인의 미래 예약 변경 |
| `DELETE /api/v1/me/schedules/{id}` | 204. 본인의 미래 예약 취소 |
| `GET /api/v1/channels/{handle}/schedule` | 비로그인 200 `{items:[{id,title,at}]}`. 미래 예약 최대 200건, 가까운 시간순 |
| `POST /api/v1/me/channel/connection` | `{streamKey}` → 200 `Channel`. 아래 명시적 OBS 소유권 연결 |
| `GET /api/v1/studio` | 200 현재 사용자의 기존 OBS 상태·송출 정보. 미연결은 403 `CHANNEL_NOT_CONNECTED` |
| `PUT /api/v1/studio`, `PATCH /api/v1/studio` | `{title,publisher?}` → 200 갱신된 스튜디오 상태. DB에 연결된 자기 경로만 변경 |
| `GET /api/v1/me/missions` | 소유 채널의 무료 미션 목록. `status=all|received|running|completed|rejected|canceled|expired|failed`, `q`, `from`, `to`, `limit`, `cursor` |
| `GET /api/v1/me/missions/{id}` | 소유 미션 상세와 상태 변경 이력 |
| `PATCH /api/v1/me/missions/{id}` | `{version,status,reason}`으로 방송자 수락·최종 처리 |
| `GET /api/v1/missions/current` | 현재/과거 방송 키의 내 제안·참여 가능 상태. 공개 미션 목록은 없음 |
| `POST /api/v1/missions` | 현재 방송에 무료 미션 제안. UUID 멱등 접수 |
| `POST /api/v1/missions/{id}/cancel` | 제안자가 접수 상태 미션을 `{version}`으로 취소 |

필수 텍스트 값과 JSON 객체를 서버에서 검증한다. 쓰기 본문은 최대 8KB이며 채팅 설정 PATCH만 최대 16KB다. 초과하면 413 `BODY_TOO_LARGE`다. 비밀번호는 Unicode 문자 10~128자, 계정·채널 표시 이름은 공백 제거 후 1~30자다. 가입 요청에 `handle`이 없거나 `null`이면 서버가 `ch-`와 80bit 암호학적 난수의 소문자 16진수 20자를 조합한 고유 주소를 발급한다. 이메일이나 닉네임에서 주소를 유추하지 않는다. 응답의 `channel.handle`이 현재 주소이며 채널 UUID는 주소·이름 수정에도 유지한다.

이전 API 사용자의 명시적인 `handle`도 호환을 유지한다. 이 경우 ASCII 영문 대소문자를 받아 소문자로 정규화한 `[a-z][a-z0-9_-]{2,23}` 형식을 검증하고 빈 문자열·예약 주소·중복 주소를 거절한다. 자동 주소의 고유성은 현재·과거 주소가 공유하는 PostgreSQL 예약 표의 기본 키가 보장하며 `ON CONFLICT(handle) DO NOTHING`으로 충돌 시 최대 5번 새 후보를 시도한다. 실패가 PostgreSQL 트랜잭션을 중단 상태로 만들지 않으며 모든 후보가 실패하면 503 `CHANNEL_CREATION_UNAVAILABLE`과 함께 계정·동의·채널 생성을 모두 롤백한다. 이메일은 최대 254자, 채널 설명 500자, 공지 1,000자다. 카테고리는 `개발·작업`, `게임`, `일상·이야기`, `디자인·창작`, `지식·탐색` 중 하나다.

계정 표시 이름과 채널 표시 이름은 독립적이다. 팔로우의 `(user_id,channel_id)` 기본 키와 외래 키를 DB가 강제하고 자기 채널 팔로우는 거절한다. 공개 응답에는 소유자 내부 ID·송출 경로 설정·자격 증명을 넣지 않는다.

## 채널 프로필·주소·신고

`PATCH /api/v1/me/channel`의 `handle`, `countryCode`, `links`는 선택 필드다. 생략하면 기존 값을 보존한다. `countryCode:null`은 국가를 지우고 `links:[]`는 링크를 지운다. 국가는 Java Locale의 ISO 3166 alpha-2 목록을 사용하며 소문자 입력도 대문자로 저장한다. 알 수 없는 국가 코드는 400 `INVALID_COUNTRY`다.

링크는 순서를 유지하는 최대 14개 배열이다. 각 항목은 `title`·`url` 두 필드만 받는다. 제목은 공백 제거 후 Unicode 1~50자, URL은 공백 제거 후 최대 500자의 절대 HTTP(S) 주소로 host가 있어야 하며 사용자명·비밀번호, 제어 문자를 허용하지 않는다. 서버가 링크를 가져오거나 확인 요청을 보내지는 않는다. 잘못된 배열·제목·주소는 400 `INVALID_CHANNEL_LINKS`다. 개별 필드 한도와 별도로 JSON 전체의 8KB 제한을 적용한다.

주소 수정은 본인의 채널 행을 잠근 뒤 프로필 저장과 같은 트랜잭션에서 처리한다. `product_channel_handles` 한 표가 현재 주소와 모든 과거 주소를 같은 UUID에 예약한다. 다른 채널은 현재·과거 주소를 새 가입이나 이름 변경으로 가져갈 수 없으며 409 `HANDLE_UNAVAILABLE`다. 본인은 자기 과거 주소로 되돌릴 수 있다. 과거 주소 조회·방송 일정 조회는 현재 채널을 반환하고 응답의 `handle`은 항상 현재 값이다. 채널 삭제 시에도 NULL 대상의 예약 행을 남겨 주소를 재할당하지 않는다. UUID를 사용하는 팔로우·예약·기록 관계는 주소 수정으로 바뀌지 않는다. 공유에는 `/api/v1/channel-ids/{uuid}` 조회를 사용할 수 있다.

신고 사유는 `spam`, `impersonation`, `harassment`, `inappropriate`, `other` 중 하나다. `details`는 생략하면 빈 문자열이며 `other`일 때만 내용이 필수다. 내용은 공백 제거 후 Unicode 최대 1,000자이고 줄바꿈·탭 외 제어 문자를 거절한다. 요청은 `reason`·선택 `details`만 허용한다. 잘못된 사유·본문은 400 `INVALID_REPORT_REASON`, 내용은 400 `INVALID_REPORT_DETAILS`, 자기 채널 신고는 400 `SELF_REPORT_NOT_ALLOWED`, 없는 대상은 404 `CHANNEL_NOT_FOUND`다. 신고자·대상은 로그인 세션과 경로 UUID로 결정하며 본문으로 바꿀 수 없다.

신고자의 계정 행을 잠근 같은 트랜잭션에서 중복·횟수를 검사하고 저장한다. 같은 신고자·대상·사유의 24시간 내 재접수는 409 `REPORT_ALREADY_RECEIVED`다. 신고자별 최근 1분 접수는 5건까지 허용하며 초과는 429 `REPORT_RATE_LIMITED`와 `Retry-After: 60`이다. 처리 상태가 바뀌어도 이 접수 제한의 계산에 포함한다. 거절된 요청은 행을 만들거나 접수 한도를 소비하지 않는다. 성공 시 서버 시각과 신고 UUID를 담은 `{id,status:'received',createdAtMs}`만 반환한다. 내용·신고자 정보는 공개 채널 응답이나 로그에 넣지 않는다. `received`는 접수만 의미하며 운영자 검토·조치가 끝난 것으로 표시하지 않는다.

## 운영자 신고 관리

운영자 여부는 V6의 `product_accounts.is_operator` 한 필드로 관리하며 기본값은 `false`다. 첫 가입자를 자동 승격하거나 특정 이메일을 코드에 넣지 않는다. 가입·프로필 JSON의 `isOperator`·`roles` 같은 추가 필드로 이 값을 바꿀 수 없으며 운영자 지정 API도 제공하지 않는다. 승인된 기존 계정의 DB 플래그 지정은 [로컬 유지관리 CLI 절차](../../deploy/PRODUCT_LOCAL.md#운영자-계정-지정)로 별도 수행한다. 각 관리 API는 DB의 현재 플래그를 다시 검사한다. 비로그인 요청은 401 `UNAUTHENTICATED`, 일반 계정은 신고 ID·검색 조건·존재 여부를 조회하기 전에 403 `OPERATOR_REQUIRED`다. 같은 로그인 쿠키에서도 권한 부여·철회가 다음 요청부터 반영된다. 쓰기 요청에는 기존 CSRF·Origin·8KB JSON 한도를 적용한다.

목록의 `Report`는 `{id,status,reason,details,createdAtMs,updatedAtMs,version,channel:{id,handle,displayName},reporter:{id,displayName}}`이다. 상세 `ReportDetail`은 이 필드에 `reviewNote:string`과 `reviewedBy:null|{id,displayName}`을 더한다. 검토하지 않은 신고는 `reviewNote:''`, `reviewedBy:null`, `version:0`, `updatedAtMs:createdAtMs`다. 이름·채널 주소는 현재 값이며 원래 신고의 대상 UUID·신고자 UUID·사유·내용·접수 시각은 상태 변경으로 수정하지 않는다. 이메일·비밀번호·세션·송출 자격 증명은 관리 응답에도 포함하지 않는다. 처리자 계정이 삭제되면 처리자 참조만 `null`로 남는다.

목록 조건은 `status=all|received|reviewing|resolved|dismissed`(기본 `all`), `reason=all|spam|impersonation|harassment|inappropriate|other`(기본 `all`), `q`(제어 문자 없는 Unicode 최대 120자), `limit`(1~100, 기본 50), `cursor`다. 검색은 채널 현재 이름·주소·신고 내용에서 대소문자 구분 없는 문자열 포함 검색이며 `%`·`_`는 검색 기호로 해석하지 않는다. `created_at DESC,id DESC` keyset pagination을 사용하며 커서는 PostgreSQL 시각의 microsecond 정밀도를 유지한다. 프론트는 커서를 해석하지 않고 `nextCursor`를 다음 요청에 그대로 사용하며 `null`이면 마지막 페이지다. 목록은 처리 메모와 처리자 정보를 포함하지 않는다.

변경 본문은 `status`, `reviewNote`, `version` 세 필드만 받는다. `status`는 `reviewing`, `resolved`, `dismissed` 중 하나이며 전이는 `received → reviewing/resolved/dismissed`, `reviewing → resolved/dismissed`만 허용한다. 같은 상태에서 메모만 바꾸거나 접수 상태로 되돌리지 않는다. 메모는 공백 제거 후 Unicode 최대 1,000자이고 줄바꿈·탭 외 제어 문자는 허용하지 않는다. `resolved`·`dismissed` 종결에는 빈 메모를 허용하지 않는다. `version`은 조회한 0 이상의 JSON 정수를 그대로 보낸다.

변경 트랜잭션은 현재 운영자 계정의 권한과 대상 신고 행을 잠근 뒤 전이·버전을 검사하고 서버 시각·운영자 UUID를 저장하며 버전을 1 올린다. 동시 같은 버전 변경은 하나만 성공한다. 다른 운영자가 먼저 바꾼 버전은 409 `REPORT_CONFLICT`, 이미 종결된 신고는 버전에 관계없이 409 `REPORT_ALREADY_CLOSED`이며 내용·상태·처리자를 다시 쓰지 않는다. 같은 상태 전이는 400 `INVALID_REPORT_TRANSITION`이다. 잘못된 ID·필터·커서·수정 본문·처리 메모는 각각 400 `INVALID_REPORT_ID`·`INVALID_REPORT_FILTER`·`INVALID_REPORT_CURSOR`·`INVALID_REPORT_UPDATE`·`INVALID_REVIEW_NOTE`, 없는 신고는 404 `REPORT_NOT_FOUND`다.

이 기능은 신고를 검토하고 처리 결과를 기록한다. 채널 정지·방송 종료·콘텐츠 삭제를 실행하지 않는다. 운영자는 자신의 신고도 검토할 수 있으며 담당자 배정·일반 역할 관리·별도 이벤트/감사 이력 시스템은 두지 않는다. 현재 행에 마지막 처리 상태·메모·처리자·시각·버전만 보존하고 종결 뒤에는 API로 수정하지 않는다.

## 개인 알림

`Notification`은 `{id,kind:'live'|'report',title,body,createdAtMs,readAtMs:null|number,target:null|{channelId,channelHandle,broadcastId,path,available:boolean},report:null|{id,status:'resolved'|'dismissed'}}`다. 모든 필드는 항상 포함한다. 라이브 알림은 `target`이 있고 `report:null`, 신고 결과 알림은 `target:null`과 본인의 접수 번호·최종 상태만 포함한다. 신고 결과 본문은 대상 채널의 공개 이름과 일반 안내 문구의 snapshot이며 원래 신고 내용·운영자 비공개 메모·처리자 정보는 담지 않는다. 신고 알림으로 관리 API 권한을 얻지 않는다.

모든 조회·변경은 로그인한 본인의 알림에만 적용하며 쓰기에 기존 CSRF·Origin 검사를 적용한다. 목록·카운트·모든 변경 응답의 `userId`는 실제 인증된 수신자 UUID다. 브라우저는 각 알림 요청에 화면에서 인식한 계정 UUID를 `X-FRAME-USER-ID`로 보낸다. 헤더가 있고 현재 로그인 UUID와 다르면 알림 데이터 조회·변경 전에 409 `SESSION_CHANGED`로 거절한다. 헤더를 생략한 직접 API 호출은 기존 쿠키 인증을 사용한다. 클라이언트는 응답의 `userId`도 화면 계정과 비교해 다른 탭의 계정 전환 뒤 응답을 이전 계정 화면에 적용하지 않는다.

목록 조건은 `filter=all|unread`(기본 `all`), `kind=all|live|report`(기본 `all`), `limit`(1~100, 기본 50), `cursor`다. 서버의 알림 생성 millisecond·행 UUID 내림차순 keyset pagination을 사용한다. `nextCursor:null`이면 마지막 페이지다. `unreadCount`는 필터·현재 페이지와 관계없이 본인 전체 미확인 행 수다. 읽음 처리는 서버 시각을 저장하고 이미 확인한 행의 시각을 바꾸지 않는다. 전체 읽음·전체 삭제는 대상이 없어도 200이다. 없는 알림과 타인 알림의 개별 읽음·삭제는 같은 404 `NOTIFICATION_NOT_FOUND`이며 잘못된 ID·필터·커서는 400 `INVALID_NOTIFICATION_ID`·`INVALID_NOTIFICATION_FILTER`·`INVALID_NOTIFICATION_CURSOR`다. 모든 응답은 `Cache-Control: no-store`다.

라이브 시작 알림은 알림을 켠 팔로워에게만 생성한다. V7은 기존 알림 ON 관계의 `notifications_enabled_at`을 적용 시각으로 기록하며, 이후 OFF→ON 전환에만 새 시각을 기록한다. 방송 시작 뒤 새로 팔로우하거나 알림을 켜도 이미 시작한 방송의 알림을 보내지 않는다. 채널 내부 `notification_live_after_ms`는 V7 적용·새 채널 생성·최초 송출 경로 연결의 기준 시각이다. 그보다 먼저 시작한 미디어는 처음 확인한 기존 방송으로 취급해 시작 알림을 만들지 않는다. 기존 ON 여부·팔로우 생성일은 보존하며 과거 방송 알림을 초기 데이터로 만들지 않는다.

제품 기능이 활성화된 경우에만 전용 단일 작업자가 5초마다 기존 MediaMTX 캐시와 Registry를 대조한다. MediaMTX 목록이 최신·정상이고 원본 경로가 실제 ready이며 방송이 같은 미디어를 관측한 경우만 처리한다. source type·source ID·ready 시각으로 세션 지문을 만든다. 이전 MediaMTX가 source ID를 생략하면 양수 ready 시각과 type으로만 대체하며 ready 시각이 없으면 알림을 만들지 않는다. 현재 방송 시작보다 10초 넘게 오래된 원본을 새 방송 시작으로 알리지 않는다.

사용자 알림 행과 별도인 `product_notification_events`에 source 세션과 방송 instance 표식을 같은 트랜잭션으로 남기고 두 표식이 모두 새로울 때만 대상 팔로워를 일괄 저장한다. 이미 처리한 source를 API 재시작 후 새 instance가 관측해도 새 instance 표식까지 예약해 재연결 알림을 억제한다. 같은 instance의 짧은 재연결도 다시 알리지 않는다. API 재시작 후 실제 source와 방송 instance가 모두 새로 시작한 경우는 새 시작으로 처리할 수 있다. 알림을 삭제해도 표식은 남으므로 재조회·재시도·재시작으로 삭제한 알림을 복원하지 않는다. 제목은 당시 채널 이름, 본문은 당시 방송 제목이며 PostgreSQL text가 받지 못하는 NUL만 대체 문자로 저장한다.

라이브 대상의 `available`은 저장된 방송 ID·경로·instance·source 세션이 현재 최신 미디어와 일치할 때만 참이다. 종료·교체·API 재시작 후 이전 링크를 다음 방송으로 바꾸지 않는다. 알림 자체와 제목은 보존하고 현재 채널 handle을 반환하므로 클라이언트는 `channelId`로 채널을 열 수 있다. 현재 채널도 삭제됐다면 해당 조회는 정상적인 채널 없음으로 처리된다. 임의 외부 URL은 저장·반환하지 않는다.

라이브 알림 DB 작업은 Registry 이벤트 리스너와 미디어 스케줄러에서 실행하지 않는다. 별도 작업자에서 트랜잭션 3초·SQL 1.5초·잠금 1초 한도를 두고 실패는 다음 주기에 재시도한다. 데이터·예외 내용은 로그로 출력하지 않으며 DB 실패가 송출 등록·재생 흐름으로 전파되지 않는다. 신고가 `resolved`·`dismissed`로 종결될 때는 검토 변경과 같은 트랜잭션에서 신고자에게 일반 결과 알림 하나를 저장한다. 종결과 알림이 함께 커밋되며 재시도·삭제 후 직접 중복 생성도 별도 표식이 막는다. SSE·브라우저/OS 푸시·이메일·Redis 큐·추가 메시지 브로커는 사용하지 않는다.

## 채팅 관리·회원 송신

`ChatSettings`는 `{userId,channelId,version,updatedAtMs,slowMode,slowSeconds,followersOnly,blockLinks,bannedWords:string[]}`다. 기본값은 느린 모드 OFF·간격 5초·팔로워 전용 OFF·링크 제한 OFF·금칙어 빈 배열이며 버전은 0이다. V8은 기존 채널에 이 기본 정책을 저장하고 새 가입도 채널 생성 트랜잭션에서 기본 정책을 만든다. `slowSeconds`는 JSON 정수 1~120, 금칙어는 최대 100개·각각 공백 제거 후 Unicode 1~30자다. NFKC·대소문자·보이지 않는 format 문자 제거 후 같은 금칙어는 처음 항목만 보존한다. 금칙어 배열은 채널 소유자의 관리 응답에만 포함한다.

설정 변경은 본인의 채널 행을 잠근 뒤 요청한 `version`이 현재 값과 같은지 확인하고 버전·서버 갱신 시각을 올린다. 다른 화면의 변경을 덮어쓰려 하면 409 `CHAT_SETTINGS_CONFLICT`다. 처리 결과와 최신 설정을 다시 읽어 로컬 초안을 비교할 수 있으며 자동 덮어쓰기를 하지 않는다. 다른 사용자·채널을 본문으로 지정해 변경하는 계약은 없다. 설정 본문은 위 여섯 필드만 허용하고 금칙어 최대 UTF-8 입력을 위해 이 경로에만 16KB 한도를 적용한다.

`ChatBlock`은 `{id,targetChannelId,displayName,handle,reason,createdAtMs,expiresAtMs:null|number,version}`이다. 대상은 공개 채널 UUID로 선택하지만 서버는 그 채널의 소유자 계정 UUID에 차단을 적용한다. 이름·handle 변경이나 같은 계정의 여러 탭으로 우회할 수 없다. 반환하는 이름·handle은 대상 채널의 현재 공개 정보다. `reason`은 소유자 전용 Unicode 1~200자이며 줄바꿈·탭을 허용한다. 차단당한 사람과 공개 채팅에는 이 사유를 보내지 않는다.

기간은 `durationSeconds:600`(10분), `3600`(1시간), `null`(영구)만 받는다. 만료 시각은 서버에서 계산하며 만료된 행은 즉시 송신 제한에서 제외한다. 목록은 `status=active|all|expired`(기본 `active`), `q`(제어 문자 없는 Unicode 최대 120자), `limit`(1~100·기본 50), `cursor`를 지원한다. 이름·handle·제한 사유를 대소문자 구분 없는 포함 검색으로 찾고 생성 millisecond·UUID 내림차순으로 페이지를 나눈다. 활성 차단은 채널마다 최대 200개이며 생성은 채널 행 잠금으로 동시 상한을 지킨다. 이미 활성인 대상은 409 `CHAT_BLOCK_EXISTS`, 자기 계정은 400 `SELF_BLOCK_NOT_ALLOWED`, 상한은 409 `CHAT_BLOCK_LIMIT`이다.

차단 해제는 행 UUID와 조회한 `version`을 사용한다. 타인의 행·이미 해제한 행은 404 `CHAT_BLOCK_NOT_FOUND`, 다른 버전은 409 `CHAT_BLOCK_CONFLICT`다. 해제는 실제 삭제하며 따로 가짜 복원 행을 만들지 않는다. 만료된 계정을 다시 차단하면 이전 만료 행을 새 UUID·시각으로 교체한다. 차단 편집·제재 감사 이력·현재 방송 종료까지의 기간은 이번 범위에 없다. 잘못된 관리 입력·금칙어·커서는 400 `INVALID_CHAT_INPUT`·`INVALID_BANNED_WORDS`·`INVALID_CHAT_CURSOR`다.

설정·차단 API는 쿠키 인증·CSRF·정확한 Origin과 `X-FRAME-USER-ID` 계정 전환 검사를 사용한다. 응답의 `userId`는 관리 대상 채널의 실제 소유자다. 일반 운영자 플래그로 남의 채널 채팅을 관리하지 않는다. 소유자가 설정·차단·해제를 커밋하면 해당 채팅 연결에 공개 정책과 제한 상태만 보낸다. 공개 정책은 `{slowMode,slowSeconds,followersOnly,blockLinks}` 네 필드이며 금칙어 배열·내부 제한 사유·관리자 정보를 포함하지 않는다.

제품 기능 ON의 `/{path}/chat` WebSocket은 설정한 제품 Origin만 허용한다. HTTP API 밖의 미디어 경로에 Redis 세션 필터를 넓히지 않으며, 송신 신원은 `/api/v1/chat/tickets`의 짧은 일회 티켓으로 확인한다. 티켓 요청은 현재 방송 ID·경로와 로그인 세션에 바인딩하며 응답에 세션 ID를 담지 않는다. 티켓은 URL이나 로그에 넣지 않고 `{type:'join',broadcastId,ticket}` JSON으로만 보낸다. 30초 뒤 만료되고 한 번 소비한 티켓은 다시 쓸 수 없다. 다른 경로·방송·내부 instance로 옮기지 못하며 서버 재시작 뒤에는 새로 발급한다. 발급은 사용자별 burst 10·초당 0.5개의 요청 제한과 전체 활성 티켓 10,000개 한도를 둔다.

티켓 없는 손님은 `{type:'join',broadcastId}`로 공개 채팅·최근 기록을 읽을 수 있지만 송신할 수 없다. 클라이언트가 보낸 `name`·`userId`로 신원을 정하지 않는다. 유효한 회원 티켓의 이름은 서버 계정 표시 이름이며 제품 모드의 `name` 명령은 `CHAT_IDENTITY_FIXED`로 거절한다. 공개 메시지·기록은 기존 `author`에 `authorChannelId`, `authorHandle`, `isOwner`를 서버 값으로 추가한다. 공개 메시지에 이메일·계정 UUID·세션·티켓을 넣지 않으며 동명이인은 공개 handle로 구분한다. 제품 채널에 연결되지 않은 기존 송출은 회원도 `CHAT_CHANNEL_UNAVAILABLE`로 송신하지 못하고 읽기만 가능하다.

회원 state는 기존 필드에 `authenticated`, `userId:null|UUID`(자기 신원), `authorChannelId:null|UUID`, 공개 `policy`를 더한다. 손님은 `canSend:false`, `code:'CHAT_LOGIN_REQUIRED'`다. 무효 티켓은 `connected:false`, `code:'CHAT_AUTH_INVALID'`와 1008 종료로 처리한다. 활성 연결의 신원은 다른 계정으로 교체하지 않으며 계정 전환은 새 티켓·연결을 사용한다. 이미 인증한 연결은 임시 차단 만료 시 같은 방송으로 join을 다시 보내 현재 세션·제한 상태를 확인할 수 있다. 팔로워 제한은 송신할 때 판정하므로 실제 팔로우 뒤 같은 연결에서 다시 보낼 수 있다.

각 송신은 Redis의 현재 세션·principal·절대 만료를 다시 확인하고 DB의 계정·채널 연결·정책·계정 차단을 재검사한다. 로그아웃·로그인 세션 교체·계정 삭제 뒤 기존 소켓도 송신할 수 없다. Redis 연결/명령은 기존 각 2초 한도, DB preflight는 읽기 트랜잭션 3초 한도를 사용한다. 세션·DB 실패는 일반 `CHAT_UNAVAILABLE` 안내와 송신 거절로 처리하고 예외·자격 증명을 응답하지 않는다. 이 대기는 ChatHub의 전역 방 잠금 밖에서 수행하며 마지막 방·instance 검사를 잠금 안에서 다시 한다.

금칙어는 메시지의 NFKC·대소문자·보이지 않는 format 문자를 정규화한 뒤 문자열 포함으로 검사한다. 링크 제한은 HTTP(S)·www·일반적인 도메인 표기 규칙으로 검사하며 모든 변형을 탐지하는 범용 분류기로 표시하지 않는다. 금칙어·링크는 소유자에게도 적용한다. 소유자는 자기 팔로우가 불가능하므로 팔로워 전용과 느린 모드만 면제한다. 느린 모드는 같은 계정·같은 채널의 여러 연결이 한 제한을 공유한다. 이 마지막 송신 시각은 프로세스 메모리라 API 재시작 시 초기화되며 지속 쿨다운을 보장하지 않는다. 기존 연결별 10초 8회·IP 속도 제한도 유지한다.

거절 ack는 기존 `{type:'ack',clientId,ok:false,error}`에 `code`와 필요한 경우 `retryAfterMs`를 더한다. 회원 정책 코드는 `CHAT_LOGIN_REQUIRED`, `CHAT_SESSION_EXPIRED`, `CHAT_AUTH_INVALID`, `CHAT_CHANNEL_UNAVAILABLE`, `CHAT_BLOCKED`, `CHAT_FOLLOW_REQUIRED`, `CHAT_SLOW_MODE`, `CHAT_LINK_BLOCKED`, `CHAT_WORD_BLOCKED`, `CHAT_UNAVAILABLE`다. 임시 차단·느린 모드는 남은 대기 시간을 보내며 영구 차단에는 만료 시각을 만들어내지 않는다. 차단은 읽기를 막지 않고 송신만 제한한다. 채팅 메시지는 기존 서버 메모리 최근 200건·입장 시 100건 계약을 유지하며 DB에 메시지 이력을 새로 저장하지 않는다. 제품 기능 OFF에서는 기존 이름 설정·relay 프로토콜·테스트 계약을 유지한다.

## OBS 공개 채팅 오버레이

외부 도구 연결 화면은 본인 채널 UUID의 `/_frame/overlay/chat/{channelId}` 주소를 생성한다. [OBS 브라우저 소스](https://obsproject.com/kb/Browser-Source)의 URL에 이 주소를 넣어 공개 채팅을 표시한다. 채널 UUID를 사용하므로 핸들을 바꿔도 주소를 유지한다. 공개 읽기 주소이며 송출 키·API 키·비밀 토큰·로그인 권한을 넣지 않는다. 외부 채팅봇·API 키·웹훅은 아직 제공하지 않는다.

| Query | 기본값 | 범위 |
|---|---|---|
| `theme` | `dark` | `dark`, `light` |
| `fontSize` | `20` | 정수 14~32 px |
| `maxMessages` | `8` | 정수 1~20 |
| `hideAfterSeconds` | `30` | 정수 0~120초, 0은 계속 표시 |
| `preview` | 없음 | `1`일 때만 체크무늬·연결 상태·재시도 표시 |

잘못된 옵션은 해당 기본값으로 해석한다. 표시는 주소에 저장하며 DB의 채널 설정이나 연결 상태를 변경하지 않는다. 관리 화면의 방송 중/대기는 실제 공개 메타데이터 기준이며 OBS가 주소를 열었다는 확인 표시가 아니다. 주소를 바꿨으면 OBS 브라우저 소스의 URL도 갱신한다.

오버레이는 앱 탐색·로그인 초기화 밖에서 실행한다. 기존 `GET /api/v1/channel-ids/{channelId}`를 `credentials: omit`, `cache: no-store`로 조회하고 현재 방송의 기존 `/{path}/chat` WebSocket에 티켓 없는 `join`만 보낸다. 세션·CSRF·채팅 티켓·송출 정보·시청 세션·영상·시청 기록·포인트 API를 호출하지 않는다. WebSocket handshake의 같은 출처 쿠키가 있더라도 회원 티켓을 발급하지 않아 계정 신원이나 송신 권한으로 사용하지 않는다. 읽기 전용 클라이언트의 전송·닉네임 변경도 막으며 기존 회원 채팅의 티켓 인증·Origin·연결 상한은 유지한다.

공개 채널을 약 5초마다 확인해 방송 시작·종료·교체를 따라가고 같은 방송은 소켓을 다시 만들지 않는다. 종료·교체·메타데이터 조회 실패 시 이전 메시지를 비우고, 재연결은 기존 채팅 지연 정책을 사용한다. 새 기록 저장이나 시청자·포인트 집계를 만들지 않는다. 메시지 표시 시간은 서버 메시지의 전송 시각 기준으로 적용하며 최대 개수 안에서 마지막 메시지를 남긴다. 텍스트는 React 텍스트로 렌더한다. 일반 OBS 주소는 빈 상태·오류에서도 투명하고, 연결 안내는 명시적인 미리보기 주소에만 표시한다. 페이지 이탈 시 요청·소켓·타이머와 임시 배경 스타일을 정리한다.

## 실제 투표

`Poll`은 `{id,channelId,broadcastId,path,question,createdAtMs,endsAtMs,status:'active'|'closed',closeReason:null|'manual'|'expired'|'broadcast_ended',version,options:[{id,text,votes}],totalVotes,myOptionId:null|UUID}`다. 선택지는 생성 순서를 유지하며 표 수와 합계는 실제 투표 행을 집계한다. 개인 선택은 현재 인증 계정의 `myOptionId`만 반환하고 투표자 UUID·이메일·명단·내부 방송 instance를 공개하지 않는다. 소유자·공개 조회·투표 응답 모두 같은 `Poll` 형식이다. 모든 wrapper의 `serverNowMs`는 서버 epoch milliseconds이며 클라이언트 시계 차이를 보정하는 기준으로 사용한다.

소유자 목록 조건은 `status=all|active|closed`(기본 `all`), `q`(제어 문자 없는 Unicode 최대 120자), `from`·`to`(`YYYY-MM-DD`, 서울 시간 양 끝 날짜 포함), `limit`(1~100·기본 50), `cursor`다. 제목을 대소문자 구분 없이 포함 검색하고 생성 millisecond·UUID 내림차순으로 페이지를 나눈다. `nextCursor:null`이면 마지막 페이지다. `activePollId`는 검색·상태·기간·페이지에 관계없이 해당 채널 현재 방송의 유효한 진행 투표 UUID이며 없으면 `null`이다. 필터가 현재 투표를 숨겨도 새 투표 생성 가능 여부를 첫 페이지 행으로 추측하지 않는다.

목록의 `currentBroadcast`는 `{id,path,title}` 또는 `null`이다. 세션에 저장했던 채널 상태를 재사용하지 않고 실제 Registry·정상 최신 MediaMTX 원본 ready·관측한 미디어 일치 여부로 생성 가능한 현재 방송만 반환한다. 만들기 요청은 그 응답의 `broadcastId`·`path`를 다시 보내며 서버는 저장할 때 재검사한다. 실제 송출 중인 본인 방송이 없거나 방송이 바뀌었으면 409 `POLL_BROADCAST_UNAVAILABLE`이다. 방송 URL을 본문으로 임의 지정해 남의 채널에 생성할 수 없다.

질문과 각 선택지는 앞뒤 공백 제거 후 Unicode 1~100자이며 제어 문자·보이지 않는 문자만으로 만든 빈 항목을 허용하지 않는다. 선택지는 2~8개, NFKC·대소문자 정규화 후 서로 달라야 한다. 진행 시간은 `durationSeconds` 60·180·300·600(1·3·5·10분)만 받는다. ID·시작/마감 시각·선택지 ID·초기 표 수는 서버가 정하며 요청에는 위 다섯 필드만 허용한다. 본문은 기본 8KB 한도를 적용한다. 잘못된 입력·중복 선택지는 400 `INVALID_POLL_INPUT`·`DUPLICATE_POLL_OPTIONS`다.

한 채널에는 유효 진행 투표 하나만 둔다. 생성은 채널 행을 잠근 뒤 기존 슬롯을 검사하고 DB 부분 고유 인덱스로 열린 저장 슬롯의 중복도 막는다. 진행 중인 투표가 있으면 409 `POLL_ACTIVE_EXISTS`다. 만료·종료된 방송의 이전 슬롯은 새 투표 생성 트랜잭션에서 정리하고 이력·선택지·실제 표를 보존한다. 생성 요청은 사용자별 burst 8·초당 0.1개, 새 투표 참여는 burst 20·초당 2개로 제한하며 초과는 429 `POLL_RATE_LIMITED`다.

마감은 별도 작업 없이 서버 wall clock으로 판정한다. 저장된 수동/정리 마감 사유가 우선이고, 아직 저장 마감하지 않은 행은 기한 도달 `expired`, 그다음 현재 Registry의 ID·경로·instance가 달라진 경우 `broadcast_ended`, 나머지는 진행 중이다. 서버가 방송 종료 시각 전체를 영속 기록하는 기능으로 표현하지 않는다. API 재시작 후 같은 송출 원본이 계속 들어와도 새 Registry instance이므로 이전 투표는 마감된 결과로 남고 새 방송 투표 생성을 막지 않는다. 이 기능에서 MediaMTX source fingerprint로 방송 ID를 복원하거나 미디어 동작을 재설계하지 않는다.

수동 마감은 현재 `version`을 보내며 버전과 상태를 다시 검사한다. 버전이 다르면 409 `POLL_CONFLICT`, 이미 수동 마감·만료·방송 종료로 닫힌 투표는 409 `POLL_CLOSED`다. 관리 마감·이전 슬롯 정리는 버전을 올리지만 시청자의 표마다 버전을 올리지 않는다. 타인 투표·없는 투표의 소유자 조회/마감은 같은 404 `POLL_NOT_FOUND`다. 투표 문항·선택지 수정, 투표 삭제와 응답 취소는 지원하지 않는다. 시청자 Q&A는 아래 별도 질문 계약을 사용한다.

`PollView`는 `{userId:null|UUID,poll:null|Poll,canVote,reason:null|'login_required'|'blocked'|'followers_only'|'already_voted'|'closed'|'broadcast_unavailable',serverNowMs}`다. 공개 current GET은 익명에게 허용하며 지정한 `path`·`broadcastId`에 해당하는 최신 투표만 조회한다. 마감 뒤에도 같은 방송의 결과를 보여줄 수 있다. 이전 방송 주소로 요청하면 해당 이전 결과 또는 `null`만 반환하며 같은 경로의 다음 방송 투표를 대신 보여주지 않는다. 투표가 없고 현재 방송도 확인되지 않으면 `broadcast_unavailable`이다.

참여는 현재 로그인 계정으로만 저장하고 `(poll_id,user_id)` 기본 키가 한 표를 보장한다. 선택지의 복합 외래 키로 다른 투표의 선택지를 섞을 수 없다. 같은 선택의 재시도는 이미 마감됐어도 기존 표를 확인하는 200 응답이며 표를 추가하지 않는다. 다른 선택으로 바꾸려 하면 409 `POLL_ALREADY_VOTED`다. 요청 방송 키가 저장된 투표와 다르면 409 `POLL_BROADCAST_MISMATCH`, 다른 투표의 선택지는 400 `INVALID_POLL_OPTION`이다. 원래 키에 맞는 신규 표만 현재 기한·Registry instance·권한을 검사한 뒤 저장한다.

채팅 관리의 활성 계정 차단은 투표에도 적용해 403 `POLL_PARTICIPATION_BLOCKED`로 거절한다. 팔로워 전용 설정도 적용해 403 `POLL_FOLLOW_REQUIRED`를 반환하며 채널 소유자만 자기 팔로우 면제다. 소유자도 실제 계정 한 표로 참여할 수 있다. 채팅의 느린 모드·금칙어·링크 제한은 선택지 투표에 적용하지 않는다. 제한 사유·차단 내부 메모는 투표 응답에 담지 않는다. 생성·마감·참여는 동일 채널 행 잠금으로 직렬화하고, 공개/소유자 결과의 선택지 집계와 내 선택은 짧은 repeatable-read 트랜잭션의 같은 DB snapshot에서 읽는다.

소유자 API와 투표 POST는 기존 인증·CSRF·Origin 검사를 사용한다. 소유자 wrapper의 `userId`는 실제 관리 계정, 공개/참여 wrapper는 실제 조회 계정 또는 `null`이다. 공개 GET도 `X-FRAME-USER-ID`가 있으면 현재 인증과 비교하며 다른 탭에서 계정이 바뀌었으면 조회·변경 전에 409 `SESSION_CHANGED`로 거절한다. 쿠키 없는 손님 조회는 Redis 세션을 새로 만들지 않고 개인 선택을 포함하지 않는다. 인증 쿠키의 세션을 확인할 수 없는 장애를 손님 성공 응답으로 바꾸지 않는다. 필터·커서 오류는 400 `INVALID_POLL_FILTER`·`INVALID_POLL_CURSOR`이며 모든 응답은 `Cache-Control: no-store`다.

## 질문과 답변

질문과 답변은 기본적으로 작성자와 해당 채널 소유자에게만 보인다. **방송자가 고정한 질문 한 건만 질문·작성자 공개 채널 정보·답변을 함께 전체 공개한다.** 답변이 없는 질문도 고정할 수 있다. 고정 해제 뒤의 공개 조회에서는 즉시 제외되지만, 이전에 공개한 내용을 이미 받은 사람이 보관하지 않는다고 보장하지 않는다. 질문 원문을 일반 공개 목록이나 다른 로그인 사용자의 목록으로 반환하지 않는다.

`Question`은 `{id,channelId,broadcastId,path,text,author:{channelId,handle,displayName},answer:null|string,answeredAtMs:null|number,pinned,broadcastActive,version,createdAtMs,updatedAtMs}`다. 별도의 상태 문자열 대신 `answer:null`이 미답변이다. 작성자의 공개 채널 UUID·주소·표시명만 사용하며 계정 UUID·이메일·내부 차단 사유는 포함하지 않는다. `OwnQuestion`에만 작성자가 제출한 `clientRequestId` UUID를 추가한다. 소유자 조회와 공개 고정 질문에는 이 요청 식별자가 없다. 모든 wrapper의 `serverNowMs`와 시각 필드는 서버 epoch milliseconds다.

소유자 목록 필터는 `status=all|waiting|answered`, `q` 최대 120자, `from`·`to` KST 날짜(양 끝 포함), `limit=1..100`(기본 50), `cursor`다. 질문·답변·작성자 이름·주소를 대소문자 무시 리터럴로 검색하고 `(created_at_ms,id)` 내림차순 keyset으로 조회한다. `currentBroadcast`는 현재 Registry에 등록된 본인 연결 경로의 `{id,path,title}` 또는 `null`이다. 질문은 채팅과 같은 현재 등록 방송 기준이며, 투표 생성의 최신 미디어 ready 검사와는 다르다. `pinnedQuestionId`는 검색·상태·기간·페이지와 무관한 현재 방송의 유효 고정 UUID 또는 `null`이다. 없는 질문과 타인 채널 질문의 조회·수정은 같은 404 `QUESTION_NOT_FOUND`다.

소유자 PATCH는 현재 `version`과 `answer`·`pinned` 중 하나 이상을 보낸다. 답변은 1~1,000자이며 비우기·삭제는 지원하지 않는다. 다른 화면에서 수정한 버전은 409 `QUESTION_CONFLICT`로 거절한다. 채널 행을 잠근 같은 트랜잭션에서 고정 교체와 답변을 처리하며, 이전 고정 질문의 `version`도 올려 오래된 편집 창이 덮어쓰지 못하게 한다. 부분 고유 인덱스가 채널당 저장 고정 하나를 보장한다. 과거 방송에도 답변·고정 해제를 할 수 있지만 `pinned:true`는 현재 같은 Registry instance에만 허용한다.

`QuestionView`는 `{userId:null|UUID,pinned:null|Question,mine:OwnQuestion[],nextCursor,canSubmit,reason:null|'login_required'|'blocked'|'followers_only'|'broadcast_unavailable'|'rate_limited',retryAfterMs:null|number,serverNowMs}`다. 공개 GET의 필수 `path`·`broadcastId`는 정확한 방송 키이며, 개인 목록은 `limit=1..100`(기본 20)·`cursor`로 조회한다. 손님에게는 공개 고정 질문 외에 `mine:[]`, `nextCursor:null`만 반환한다. 로그인 사용자는 지정한 키에 보낸 자기 질문 이력을 조회할 수 있다. 이전 방송 주소·동일 ID 재사용·API 재시작 뒤에도 원문과 답변은 보존하지만 현재 ID·경로·instance와 다르면 `broadcastActive:false`, `pinned:false`, 공개 `pinned:null`이다. 같은 경로의 다음 방송 질문으로 바꿔 보여주지 않는다.

제출은 `{path,broadcastId,text,clientRequestId}` 네 필드만 받는다. 질문은 1~500 Unicode 문자, NFC·양끝 공백 제거·CRLF/CR을 LF로 정규화하며 LF/TAB 외 제어 문자와 보이지 않는 문자만 있는 입력을 거절한다. 답변도 같은 정규화와 제어 문자 규칙을 사용한다. 기본 제품 본문 상한 8KB를 따른다. 새 제출은 현재 Registry 방송·연결 채널을 재확인하고 계정 차단·팔로워 전용·일반 웹 주소·금칙어 정책을 적용한다. 소유자는 자기 팔로우만 면제하며 링크·금칙어는 동일하게 검사한다. 채팅의 느린 모드 시간은 질문에 적용하거나 소비하지 않는다. 거절 코드는 409 `QUESTION_BROADCAST_UNAVAILABLE`, 403 `QUESTION_PARTICIPATION_BLOCKED`·`QUESTION_FOLLOW_REQUIRED`, 400 `QUESTION_LINK_BLOCKED`·`QUESTION_WORD_BLOCKED`다.

작성자 계정 행의 `FOR NO KEY UPDATE` 잠금과 DB 고유 키 `(author_id,client_request_id)`로 재시도와 동시 전송을 묶는다. 같은 계정·요청 UUID에 정규화된 본문·경로·방송 ID가 같으면 기존 질문을 200으로 확인한다. 이미 방송이 끝났거나 제한된 뒤에도 재확인은 새 질문을 만들지 않는다. 같은 UUID의 다른 내용은 409 `QUESTION_REQUEST_CONFLICT`다. 응답을 잃었으면 원래 UUID와 내용을 유지해 재시도하거나 `mine[].clientRequestId`로 커밋을 확인한다.

실제 새로 저장한 질문만 계정 전체 기준 최근 60초 3건으로 제한한다. 계정 잠금으로 여러 채널·탭의 동시 요청도 직렬화하고, 저장 행의 시각을 계산하므로 API 재시작으로 한도가 초기화되지 않는다. 거절과 동일 요청 재확인은 소비하지 않는다. 초과 POST는 429 `QUESTION_RATE_LIMITED`와 `Retry-After` 초를 반환한다. 다른 참여 제한이 없을 때 공개 조회는 `canSubmit:false`, `reason:'rate_limited'`, 남은 `retryAfterMs`를 반환한다. 별도 스케줄러·큐·질문용 Redis 구조는 없다.

소유자 API와 제출 POST는 인증·CSRF·정확한 Origin 검사를 사용한다. 공개 GET도 선택적 `X-FRAME-USER-ID`를 현재 인증과 비교해 계정이 바뀌었으면 409 `SESSION_CHANGED`를 반환한다. 쿠키 없는 공개 읽기는 Redis 세션을 만들지 않으며, 인증 세션 장애를 손님 성공으로 바꾸지 않는다. 모든 응답은 `Cache-Control: no-store`다. 입력·답변·필터·커서 오류는 각각 400 `INVALID_QUESTION_INPUT`·`INVALID_QUESTION_ANSWER`·`INVALID_QUESTION_FILTER`·`INVALID_QUESTION_CURSOR`다. 현재 기능에는 삭제·질문 수정·답변 삭제·브라우저 push가 없다.

## 채널 포인트와 보상

포인트는 채널별 비현금 정수 잔액이다. 충전·환전·현금 결제·후원·토스 PG 잔액과 연결하지 않는다. 기본 잔액과 시청 누적은 0이고 샘플 보상·잔액·원장을 만들지 않는다. V11의 `product_point_wallets`, `product_point_ledger`, `product_rewards`, `product_redemptions`를 사용한다. 같은 채널을 유효하게 시청한 시간 누적 60초당 10P를 적립하며 60초 미만의 나머지 밀리초도 DB에 보존한다. 자기 채널 시청도 같은 규칙을 사용한다.

`Reward`는 `{id,channelId,name,points,limit:'once_per_broadcast'|'unlimited',enabled,version,createdAtMs,updatedAtMs}`다. 이름은 NFC·공백 정규화 뒤 1~40 Unicode 문자, 가격은 1~1,000,000 정수다. 한 채널에 활성·비활성 합계 50개까지 등록하고 삭제 대신 비활성화·기존 편집을 사용한다. 생성 UUID는 채널 내 멱등 키다. 원래 정규화된 생성 본문을 별도로 보존해, 생성 후 보상을 수정했어도 원래 UUID·본문 재전송은 추가 생성 없는 200 확인이다. UUID를 다른 생성 내용에 쓰면 409 `REWARD_REQUEST_CONFLICT`다. PATCH는 전체 네 설정과 현재 `version`을 보내며 오래된 편집은 409 `REWARD_CONFLICT`로 거절한다. 상한은 409 `REWARD_LIMIT_REACHED`, 타인·없는 보상은 404 `REWARD_NOT_FOUND`다.

소유자 보상 목록은 `status=all|enabled|disabled`, 교환 목록은 `status=all|pending|processing|completed|rejected|canceled`를 사용한다. 두 목록 모두 `q` 최대 120자, `from`·`to` KST 양끝 날짜, `limit=1..100`(기본 50), 생성 millisecond·UUID 내림차순 keyset `cursor`를 지원한다. 보상은 이름, 교환은 신청 당시 보상 이름·신청자 이름/주소·메모·처리 사유를 검색한다. 필터와 커서 오류는 400 `INVALID_REWARD_FILTER`·`INVALID_REWARD_CURSOR`다.

`Redemption`은 `{id,channelId,rewardId,rewardName,points,broadcastId,path,user:{channelId,handle,displayName},note,reason,status,version,createdAtMs,updatedAtMs}`다. `rewardName`과 `points`는 신청 당시 값이며 나중에 가격·이름을 바꿔도 이력을 바꾸지 않는다. `OwnRedemption`에만 신청자의 `clientRequestId`를 추가한다. 소유자 목록에는 공개 채널 신원만 있고 계정 UUID·이메일·요청 UUID를 포함하지 않는다. 메모와 처리 사유는 0~500 Unicode 문자, CRLF/CR을 LF로 바꾸고 NFC·공백 제거를 적용한다. LF/TAB 외 제어 문자는 거절한다.

`RewardView`는 `{userId:null|UUID,channelId:null|UUID,rewards:Reward[],usedRewardIds:UUID[],balance:null|number,mine:OwnRedemption[],nextCursor,canRedeem,reason:null|'login_required'|'blocked'|'followers_only'|'broadcast_unavailable',serverNowMs}`다. 지정한 현재 방송 ID·경로의 실제 최신 ready 원본이 확인될 때 활성 보상 최대 50개 전부를 반환한다. `limit`(기본 20, 최대 100)·`cursor`는 본인 신청 `mine`에만 적용한다. `usedRewardIds`는 현재 Registry instance에서 이미 신청한 보상 전체이며 개인 목록 페이지와 무관하다. 공개 손님은 `mine:[]`, `usedRewardIds:[]`, `balance:null`이며 다른 사용자의 신청·메모·잔액을 반환하지 않는다.

이전 방송 키에는 새 방송의 보상을 대신 반환하지 않고 `rewards:[]`, `canRedeem:false`로 응답한다. 본인 과거 신청은 그대로 남긴다. 과거 키의 개인 `channelId`는 보존된 신청 행에서 복원하고 잔액·개인 목록을 같은 채널 UUID로 묶어 경로의 소유 채널이 바뀌어도 다른 지갑과 섞지 않는다. 현재 키는 현재 채널 UUID의 본인 신청만 반환한다. 방송 종료·교체·API 재시작 뒤에도 잔액·원장·신청 이력과 소유자 처리는 보존한다.

새 신청은 로그인 계정·현재 방송·실제 송출 원본·활성 보상을 확인한다. 클라이언트는 표시된 `rewardVersion`을 보내며 설정 버전이 바뀌었으면 409 `REWARD_CONFLICT`로 차감 없이 거절한다. 보상이 비활성이면 409 `REWARD_DISABLED`, 방송 키가 달라졌으면 409 `REWARD_BROADCAST_UNAVAILABLE`다. 채팅의 활성 계정 차단과 팔로워 전용 정책을 적용해 403 `REWARD_PARTICIPATION_BLOCKED`·`REWARD_FOLLOW_REQUIRED`를 반환한다. 자기 팔로우만 소유자 면제이며 느린 모드·금칙어·링크 정책은 보상 신청 메모에 적용하지 않는다.

신청의 계정 행을 `FOR NO KEY UPDATE`로 잠그고 `(user_id,client_request_id)` 고유 키로 재전송을 묶는다. 같은 보상·요청 가격 버전·정규화된 방송 키와 메모는 기존 신청을 200으로 확인하며 이후 방송 종료·가격 변경·비활성화·취소 뒤에도 새로 차감하지 않는다. 다른 내용은 409 `REDEMPTION_REQUEST_CONFLICT`다. 새 신청만 지갑 행을 잠가 잔액을 확인하고, 신청 행·차감 원장·새 잔액을 한 트랜잭션으로 저장한다. 부족하면 409 `POINTS_INSUFFICIENT`이고 행과 원장도 모두 롤백한다. 잔액은 DB 제약으로 음수가 될 수 없다. 방송당 1회는 계정·보상·Registry instance 기준이며 거절·취소·환불 뒤에도 소비한 것으로 남는다. 현재 1회 제한으로 바꾸기 전 무제한 신청도 소비 여부에 포함한다. 409 `REWARD_ALREADY_REDEEMED`를 반환한다. 별도 신청 횟수 limiter는 두지 않는다.

상태 전이는 `pending → processing|completed|rejected|canceled`, `processing → completed|rejected|canceled`이며 종료 상태는 불변이다. 소유자는 `{version,status,reason}`으로 처리하고 거절·취소에는 사유가 필요하다. 신청자는 `pending`일 때만 취소할 수 있다. 행 잠금·버전 검사로 동시 변경 중 하나만 적용하며 버전 불일치는 409 `REDEMPTION_CONFLICT`, 종료 상태는 409 `REDEMPTION_ALREADY_CLOSED`, 허용하지 않는 전이는 409 `REDEMPTION_INVALID_TRANSITION`다. 거절·취소 때 신청 당시 가격을 같은 트랜잭션에서 한 번 환불한다. 원장의 `(redemption_id,kind)` 고유 키가 차감·환불 각각 한 건을 추가 보장한다. 제공 완료에는 추가 차감·환불이 없다. 타인과 없는 신청은 같은 404 `REDEMPTION_NOT_FOUND`다.

`Ledger`는 `{id,kind:'watch'|'redemption'|'refund',delta,balanceAfter,label,redemptionId:null|UUID,createdAtMs}`다. 시청 적립·환불은 양수, 신청 차감은 음수이며 완료 시점 잔액을 함께 저장한다. `GET /me/points`는 인증된 본인의 지정 채널 지갑만 조회한다. 목록은 `limit=1..100`, `cursor`를 사용한다. 최대 잔액은 9,000,000,000,000P이고 초과는 409 `POINTS_BALANCE_LIMIT`다.

시청 적립 POST는 `viewerSessionId`(현재 HLS 세션의 32자리 hex), 페이지별 `visitId` UUID, 증가하는 `sequence`(0~9,007,199,254,740,991), `eligibleMs`(0~20,000 정수), `watching` boolean과 방송 키를 받는다. `WatchPoints`는 `{userId,channelId:null|UUID,balance,pendingWatchMs,creditedPoints,acceptedMs,reason:null|'baseline'|'stopped'|'watching_elsewhere'|'broadcast_unavailable'|'session_unavailable',serverNowMs}`다. 현재 세션의 SID·IP·브라우저 키가 일치하는지 읽기만 하고 기존 HLS admission·heartbeat·상한을 바꾸지 않는다. Registry instance와 최신 ready 원본이 일치해야 적립한다. 제품 채널이 없는 경로는 `channelId:null`, 잔액·누적 0이다.

프론트는 실제 영상 시간이 전진하고 재생 중·표시 중·온라인일 때만 `min(실제 영상 전진,클라이언트 경과)`를 모아 10초 안팎으로 보고한다. 현재 방송 DVR 재생도 허용하며 탐색 점프·일시정지·버퍼링·숨김·오프라인·종료 구간은 누적하지 않는다. 최초 유효 pulse로 적립 0의 기준을 먼저 세우고, 중단에는 `watching:false`를 보내 미전송 구간을 버린다. 서버는 같은 지갑 행을 잠그고 `min(서버 경과,eligibleMs,20초)`만 받는다. 처음·재시작·25초 초과 공백·새 방문·HLS 세션 변경에는 0으로 기준만 다시 세워 빈 시간을 따라잡지 않는다. 같은 방문의 이전·중복 sequence는 적립 0이고 다른 탭은 현재 방문의 25초 lease 동안 적립 0이다. 정지 시에도 sequence를 남겨 오래된 요청이 기준을 되살리지 못하게 한다. 서버 프로세스 UUID가 달라지면 이전 기준을 재사용하지 않는다. DB 잔액·부분 누적은 보존한다.

이 검사는 브라우저가 실제 사람이 시청 중인지 증명하는 장치가 아니다. 클라이언트 신호와 실제 미디어 세션을 확인하고 시간 가속·동시 탭의 중복·긴 공백 적립을 제한한다. 포인트 적립 오류는 영상 재생을 막는 조건으로 쓰지 않는다. 모든 개인 읽기·쓰기는 현재 계정 UUID와 `X-FRAME-USER-ID`를 비교하며, 쓰기에는 기존 CSRF·Origin 검사를 적용한다. 공개 GET도 로그인 쿠키의 실패를 익명 성공으로 바꾸지 않는다. 모두 `Cache-Control: no-store`다. 잘못된 본문은 400 `INVALID_REWARD_INPUT`·`INVALID_REDEMPTION_INPUT`·`INVALID_POINTS_INPUT`이며 기본 제품 본문 상한 8KB를 따른다.

## 방송 예약

`at`는 정수 Unix epoch millisecond이며 서버의 현재 시각보다 미래여야 한다. 최대 `253402300799999`(UTC 9999년 말)로 제한해 HTML 날짜 입력과 JavaScript 날짜의 공통 범위에 둔다. 제목은 앞뒤 공백을 제거한 Unicode 1~100자이며 제어 문자를 거절한다. JSON 문자열·소수·누락 시각과 빈 제목을 거절하고, 요청에는 `title`·`at`만 받는다. 사용자가 소유자나 대상 채널을 보내 다른 채널에 쓰는 방식은 지원하지 않는다.

동일 채널의 같은 시각에는 예약 하나만 존재할 수 있으며 DB 고유 제약으로 동시 요청도 보장한다. 채널마다 예정 예약은 최대 100건이며 생성 시 채널 행을 잠근 뒤 개수를 검사해 동시 요청도 이 상한을 넘기지 못한다. 상한 초과는 409 `SCHEDULE_LIMIT`이다. 다른 채널은 같은 시각에 예약할 수 있다. `SCHEDULE_CONFLICT`(409)는 중복 시각, `INVALID_SCHEDULE_TITLE`·`INVALID_SCHEDULE_TIME`(400)은 입력 오류다. 타인의 예약·없는 예약은 둘 다 `SCHEDULE_NOT_FOUND`(404)로 처리하고 지난 예약의 변경·취소는 `SCHEDULE_PAST`(409)로 거절한다. 본인 조회에는 가까운 미래 최대 100건과 최근 과거 최대 100건을 포함하며 공용 조회에는 미래 최대 200건만 포함한다. 모두 `Cache-Control: no-store`다.

예약의 행과 채널 외래 키는 Flyway V3 `V3__broadcast_schedules.sql`로 관리한다. 취소 시 해당 예약 행만 삭제하며 공개 목록에서도 제거된다. 실제 송출 시작·예약 알림 발송·방송 완료를 자동 실행하거나 표시하지 않는다. 지난 예약은 시각이 지난 일정이라는 뜻이고 실제 방송 여부를 의미하지 않는다.

## 시청 기록

`HistoryItem`은 `{id,kind:'live'|'vod'|'clip',broadcastId:null|string,path:null|string,title,publisher,channelHandle:null|string,thumbnailUrl:null|string,watchedAtMs,available,mediaId:null|uuid,durationMs:null|integer,positionMs:null|integer,completed:boolean,version:integer}`다. 라이브는 기존 broadcastId/path를 유지하고 mediaId·durationMs·positionMs는 null, completed는 false, version은 0이다. VOD·클립은 mediaId·서버 영상 길이·저장 위치를 포함하며 broadcastId/path/thumbnailUrl은 null이다. 모든 필드는 명시적으로 포함한다. 목록 wrapper의 userId와 미디어 상태 wrapper의 userId는 실제 인증된 계정 UUID다.

모든 시청 기록 API는 본인 로그인 세션을 사용하고 쓰기에 기존 CSRF·정확한 Origin·8KB JSON 검사를 적용한다. 브라우저는 `X-FRAME-USER-ID`를 보내고 현재 쿠키 계정과 다르면 조회·변경 전에 409 `SESSION_CHANGED`로 거절한다. 생략한 직접 호출은 기존 쿠키 인증을 사용한다. 클라이언트는 응답 userId도 확인하고 계정·영상 변경 시 이전 요청과 이벤트를 정리한다. 사용자 ID·제목·방송자·영상 길이·시청 시각·URL을 본문으로 받지 않는다. 시청 시각은 서버 epoch milliseconds이며, 제목·방송자는 저장 시점에 공개 접근 가능한 서버 메타데이터로만 채운다.

라이브 POST의 기존 두 필드 `{broadcastId,path}`와 204 응답은 유지한다. 현재 등록된 방송의 경로와 ID가 맞을 때만 저장하며 유일성은 `(user_id,path,broadcast_id,broadcast_instance_id)`다. 방송 내부 instance UUID는 클라이언트에 노출하지 않는다. 같은 방송 재시청은 같은 행의 마지막 시청 시각을 갱신하고, 송출자가 종료한 ID·경로를 재사용한 다른 방송은 별도 행으로 남긴다. `available`은 현재 Registry의 같은 instance까지 일치할 때만 참이다. 종료되거나 서버 재시작으로 instance가 사라진 기록은 제목·방송자·시각을 보존하고 재생 링크를 활성화하지 않는다. 같은 경로의 다음 방송으로 이전 기록을 바꾸지 않는다. 기존 송출이 허용하는 NUL은 PostgreSQL text 호환을 위해 Unicode 대체 문자로 저장하며 방송자 이름은 빈 문자열일 수 있다.

V17 `V17__archived_watch_history.sql`은 기존 V4 행·라이브 유일성을 보존한 채 한 테이블을 확장한다. 보관 영상의 유일성은 `(user_id,kind,media_id)`다. GET은 공개 재생 조건만 확인하고 저장 위치가 없으면 item:null을 반환한다. VOD는 ready+public+현재 보관 파일 지문, 클립은 클립과 부모 VOD의 ready+public 및 클립 보관 파일 지문을 매 GET·PUT·목록 availability 계산에 확인한다. 이미 별도 보관한 클립은 부모 VOD 물리 파일의 소실만으로 철회하지 않는 기존 정책을 따른다. 비공개·미준비·없는 영상이나 보관 파일은 해당 공개 미디어와 같은 404다. 목록은 공개 중단·파일 소실·미디어 메타데이터 삭제 후에도 저장 당시 제목·방송자·길이·위치·시각을 유지하고 available:false로 돌려준다. 비공개로 바뀐 영상의 새 제목 등은 기록에 반영하지 않는다. 미디어 FK를 두지 않아 원본 삭제로 개인 기록을 연쇄 삭제하지 않으며, 채널 삭제는 채널 참조만 null로 남긴다. 본인 계정 삭제는 기록을 함께 삭제한다.

보관 영상 PUT은 정확히 다섯 필드만 받는다. epoch/version/positionMs는 음수가 아닌 정수이며 문자열·소수·범위를 벗어난 정수를 허용하지 않는다. positionMs는 0부터 서버 durationMs까지다. completed는 boolean이며 true는 서버 끝에서 1,000ms 이내 위치만 허용하고 저장 위치를 durationMs로 맞춘다. 다시 재생한 유효한 진행은 completed:false와 이전보다 작은 위치를 저장할 수 있다. 처음 생성할 때는 GET이 준 epoch, id:null, version:0을 보내며 이미 같은 기록이 있으면 충돌한다. 이후에는 응답의 id/version을 사용한다. 성공한 갱신마다 version을 하나 올리므로 오래된 탭·역순 요청은 409 `HISTORY_CONFLICT`이며 덮어쓰지 않는다. 이 API는 실제 사람의 시청 증명·조회수·포인트 적립에 사용하지 않는다.

조회 조건은 `kind=all|live|vod|clip`, `q`(제어 문자 없는 Unicode 최대 120자), `from`·`to`(`YYYY-MM-DD`, 양 끝 날짜 포함·서울 시간), `limit`(1~100, 기본 50), `cursor`다. all은 세 종류를 함께 조회하고 제목·방송자 snapshot을 대소문자 구분 없이 검색한다. 마지막 시청 시각·행 UUID 내림차순 keyset pagination을 사용하며 `nextCursor`가 null이면 마지막 페이지다. 커서는 서버가 준 값을 같은 검색 조건으로 다음 요청에 사용한다.

삭제는 실제 서버 기록 삭제다. 단일 삭제와 배치 삭제의 누락·타인 ID는 404 `HISTORY_NOT_FOUND`, 잘못된 본문·미디어 종류·UUID·위치는 400 `INVALID_HISTORY_INPUT`, 검색 조건은 `INVALID_HISTORY_FILTER`, 커서는 `INVALID_HISTORY_CURSOR`다. 모든 변경은 본인 계정 행을 먼저 잠그고 직렬화하며, 배치 삭제는 모든 본인 행의 소유를 확인하므로 일부만 삭제하지 않는다. 성공한 단일·배치·전체 삭제마다 계정 watch_history_epoch를 한 번 올린다. 전체 삭제는 필터·페이지와 무관하고 빈 목록에서도 epoch를 올린다. 실패한 삭제는 epoch를 바꾸지 않는다. 기존 mounted 보관 영상 recorder의 늦은 최초 저장·진행 요청은 이전 epoch로 409 `HISTORY_CONFLICT`를 받아 삭제한 기록을 되살릴 수 없다. 다른 영상의 삭제도 열린 recorder를 중지하며 사용자가 명시적으로 기록을 다시 연결하거나 새 방문할 때 현재 GET 결과로 다시 시작한다. 라이브의 기존 두 필드 POST에는 epoch가 없어 이 서버 방어가 적용되지 않으며 기존 브라우저의 방문당 한 번 저장 정책을 유지한다.

보관 영상 화면은 저장 위치를 자동 적용하거나 자동 재생하지 않는다. 이어보기는 GET으로 상태를 다시 확인하고 일시정지 상태에서 탐색한다. 보이는 화면에서 playable 영상의 currentTime이 실제로 1초 이상 진행한 뒤 최초 PUT을 보내며, 이후 10초 간격으로 저장한다. 일시정지·hidden·pagehide는 마지막으로 관찰한 유효한 위치를 보내고 진행 기준을 초기화한다. 탐색은 탐색 전 위치만 저장하며 목표 위치는 새 재생 진행을 확인한 뒤 저장한다. ended 이벤트도 끝 부근의 최근 연속 진행을 확인해야 완료를 저장하고, 다시 재생한 위치는 새 1초 진행 뒤 completed:false로 바꾼다. 페이지 진입·일시정지·탐색 자체로 최초 기록을 만들지 않는다. 오프라인 전환은 미전송 진행을 버리고 이전 위치를 나중에 일괄 전송하지 않는다.

저장 응답을 받지 못하면 현재 GET의 epoch/id/version/positionMs/completed를 대조해 성공한 요청만 확인한다. 결과가 다르거나 불명확하면 자동 재전송하지 않고 `기록 다시 연결`을 통해 사용자가 명시적으로 현재 상태를 받아 재개한다. 공개 중단·영상 변경·계정 변경은 이전 이벤트와 요청을 정리한다. 완료 기록은 다음 방문에서 이어보기를 제안하지 않으며 기록 오류가 공개 영상 재생을 막는 조건은 아니다.

## 필수 가입 동의

약관 본문·제목·버전과 가입 검증의 기준은 `ProductPolicies` 한 곳에서 관리한다. 클라이언트는 가입 전에 공개 문서를 조회하고, 두 항목을 각각 확인한 뒤 응답받은 버전을 가입 요청에 포함한다. 현재 두 버전은 `2026-11-11`이다. 문자열 `"true"`나 숫자는 동의로 인정하지 않으며 두 필드 모두 JSON boolean `true`여야 한다.

필수 동의가 없거나 거짓이면 400 `CONSENT_REQUIRED`, 동의는 했으나 문서 버전이 없거나 현재 버전과 다르면 400 `CONSENT_VERSION_CHANGED`다. 이 검사는 계정·채널 행을 만들기 전에 실행한다. 가입 성공 시 `terms_version`, `privacy_version`, 서버 DB 시각 `consented_at`을 계정과 같은 트랜잭션으로 저장한다. 클라이언트가 보내는 동의 시각은 사용하지 않는다. 채널 주소 중복 등으로 가입이 실패하면 계정·동의 기록도 함께 롤백된다.

V2 마이그레이션은 기존 계정의 세 필드를 모두 `NULL`로 둔다. 과거 동의를 추정해 채우지 않으며, 기존 회원의 로그인이나 프로필 수정도 동의 기록을 생성하지 않는다. 이번 변경은 기존 회원 재동의 절차를 추가하지 않는다.

현재 문안은 FRAME의 구현 범위를 설명하는 개발 단계 문안이며 법적 완성본으로 표시하지 않는다. 정식 공개 전 운영 주체·문의 경로와 회원 탈퇴·개인정보 삭제·동의 철회 처리 절차를 확정해야 한다. 실재하지 않는 회사·연락처·보관 기한을 임의로 추가하지 않는다. 확인 기준은 [개인정보 보호법 제15조 제2항](https://www.law.go.kr/LSW/lsLinkCommonInfo.do?lsJoLnkSeq=1029334879)의 목적·항목·보유 기간·거부권 안내다.

## OBS 소유권 연결

인증된 사용자가 자신이 보유한 `obs-path?user=obs-path&pass=...` 형태의 기존 OBS 키로 연결을 요청한다. 서버는 키를 기존 `PublisherTokens`와 비교하고 해당 경로의 명시적인 단독 소유 토큰인지 확인한다. DB에는 고유한 `stream_path`만 저장하며 제출한 키는 DB·Redis·로그에 남기지 않는다. 다른 채널이 먼저 연결한 경로는 409 `STREAM_ALREADY_CONNECTED`, 이미 다른 경로에 연결한 채널은 409 `CHANNEL_ALREADY_CONNECTED`다.

연결 후 스튜디오 조회만 기존 서버 전용 송출 설정에서 해당 경로의 현재 키를 읽어 반환한다. 다른 사용자에게는 공개되지 않는다. 공개 채널의 `liveBroadcast`는 이 경로의 실제 `BroadcastRegistry`를 연결하며, `{id,path,title,publisher,thumbnailUrl,avatarUrl:null,category,viewerCount,startedAtMs,sourceVideo?}` 형식이다. `viewerCount`는 기존 HLS 시청 집계를 사용하며 수용량 주장이 아니다.

기존 `/api/obs/*`와 `/api/payments/*`의 Bearer 인증은 제품 신고 관리의 운영자 플래그와 별개다. 로그인 쿠키와 `isOperator`로 이 Bearer API 권한을 얻을 수 없다. 제품 모드의 Vite/Caddy 경로에는 공용 운영자 Bearer를 주입하지 않는다. 계정별 결제 이관 전 `/api/v1/payments/*`는 제공하지 않는다. OAuth, 이메일 인증·복구, 이미지 업로드, 채널 삭제, 송출 연결 해제, 운영자 권한 지정 UI·팀 채널 관리는 후속 범위이며 임의 성공을 만들지 않는다.

채널 정보·팔로우·송출 경로 연결은 PostgreSQL에 남지만 현재 방송 제목·방송 ID의 수명은 기존 OBS 중계의 메모리 계약을 따른다. Spring 재시작 후 계속 송출 중인 경로는 새 방송 ID로 등록될 수 있고 방송 제목은 초기값으로 돌아간다. 이를 영속 방송 이력으로 표현하지 않는다.

## 무료 미션과 진행 이력

미션은 **무료 제안만** 처리한다. 유료 미션·후원 금액·포인트 차감·보상 지급·토스 결제에 연결하지 않으며, 완료 처리도 금전 거래를 생성하지 않는다. PostgreSQL V12의 `product_missions`, `product_mission_history`에 저장한다. 제안은 제안한 회원과 해당 채널 소유자만 읽는다. 다른 시청자에게 공개되는 미션 큐·설명·진행 사유는 없다. 익명 `GET /missions/current`는 `userId:null,mine:[]`와 로그인/방송 불가 사유만 반환한다.

제안 입력은 `{path,broadcastId,title,description,durationMinutes,clientRequestId}`다. 제목은 1~100자·한 줄, 설명은 0~1,000자·여러 줄이며 NFC·CRLF→LF·앞뒤 공백을 정규화한다. `durationMinutes`는 15/30/60 중 하나이고 **접수 시각부터** 기한을 계산한다. 수락 때 연장하지 않는다. 클라이언트가 author·결제 금액·포인트·기한 시각을 지정할 수 없다. 생성은 201, 동일 계정·UUID와 같은 정규 본문의 확인은 200이며 다른 본문 재사용은 409 `MISSION_REQUEST_CONFLICT`다. 기존 영수증 확인은 방송 종료·차단·참여 제한 뒤에도 새 제안을 생성하지 않고 먼저 반환한다. 새로 접수한 제안만 계정 전체 60초에 3개까지이며 동일 요청 확인·검증/정책 거절은 횟수를 소비하지 않는다. 429 `MISSION_RATE_LIMITED`는 `Retry-After`를 포함한다.

새 제안은 실제 fresh 원본과 현재 방송 ID·경로·내부 instance를 확인한다. 채팅의 차단·팔로워 전용·금칙어·링크 정책을 제안 제목/설명에 적용하고 채팅 느린 전송 간격은 소비하지 않는다. 소유자는 팔로워 조건만 면제한다. 제안 후 받은 미션은 원래 채널 UUID와 방송 instance를 보존하며 같은 경로의 새 방송이나 새 소유자에게 옮기지 않는다.

`Mission`은 `{id,channelId,broadcastId,path,title,description,durationMinutes,deadlineAtMs,status,reason,version,createdAtMs,updatedAtMs,broadcastActive,author,history}`다. 저자는 공개 채널 프로필 `{channelId,handle,displayName}`이며 이메일·내부 계정 UUID·방송 instance·비밀값을 넣지 않는다. `OwnMission`에만 본인 요청 확인용 `clientRequestId`가 추가된다. 이력은 `{id,status,reason,actor,createdAtMs}`이며 `actor`는 viewer/owner/system이다. 생성→수락→최종의 최대 세 항목을 DB version 순서로 반환하므로 같은 밀리초에도 순서가 고정된다. 마지막 이력 상태는 미션 현재 상태와 같다.

방송자의 전이는 received→running/rejected/canceled, running→completed/failed/canceled다. running으로 바꿀 때만 사유가 선택이고 완료·실패·거절·취소에는 1~500자 사유가 필요하다. 제안자는 received일 때만 취소할 수 있다. 완료·실패·거절·취소·만료는 최종 상태로 다시 열지 않는다. 현재 버전이 다르면 409 `MISSION_CONFLICT`, 진행 뒤 직접 취소나 허용되지 않은 전이는 `MISSION_INVALID_TRANSITION`, 최종 처리는 `MISSION_ALREADY_CLOSED`다. 소유자 요청에는 `X-FRAME-USER-ID`로 캡처한 계정을 검증하며 쿠키 계정 변경은 409 `SESSION_CHANGED`다.

접수/진행 상태가 기한을 지나거나 방송 종료·교체·API 재시작으로 원래 instance가 사라지면 expired가 된다. 기한 초과 이력은 실제 `deadlineAtMs`, 방송 종료/재시작 이력은 관측 시각과 각각의 시스템 사유를 저장한다. 별도 worker 대신 조회·변경 요청에서 관측한 만료를 영구 반영하므로 요청이 없는 동안 백그라운드 작업이 수행됐다고 표현하지 않는다. 권한을 확인한 뒤 독립 만료 트랜잭션을 끝내고, 별도 읽기/쓰기 트랜잭션을 시작해 작은 커넥션 풀의 중첩 점유를 피한다. 읽기는 repeatable-read로 미션과 이력을 같은 snapshot에서 조회한다. 변경의 마지막 잠금 안에서 새로 관측한 만료도 커밋하고 컨트롤러가 그 뒤 409 `MISSION_EXPIRED`를 반환하므로 실패 응답 때문에 만료 이력이 rollback되거나 완료로 되살아나지 않는다.

소유자 목록은 `{userId,items,nextCursor,serverNowMs}`, 상세/처리는 `{userId,item,serverNowMs}`다. 시청자 current는 `{userId,mine,nextCursor,canSubmit,reason,retryAfterMs,serverNowMs}`이고 이유는 null/login_required/blocked/followers_only/broadcast_unavailable/rate_limited다. 종료된 방송에서도 본인의 제안과 결과는 조회할 수 있다. 목록은 실제 생성 시각·UUID의 내림차순 keyset이며 소유자 검색/한국 날짜 범위/상태 필터를 지원한다. `limit`는 1~100, 소유자 기본 50·시청자 기본 20이다. 상태 처리와 취소는 미션 행 잠금·버전 검사로 직렬화하고 이력의 `(mission_id,version)` 고유 제약으로 한 전이를 한 번만 저장한다.

주요 거절은 404 `MISSION_NOT_FOUND`, 409 `MISSION_BROADCAST_UNAVAILABLE`, 403 `MISSION_PARTICIPATION_BLOCKED`/`MISSION_FOLLOW_REQUIRED`, 400 `MISSION_WORD_BLOCKED`/`MISSION_LINK_BLOCKED`다. 형식/필터/커서는 400 `INVALID_MISSION_INPUT`/`INVALID_MISSION_FILTER`/`INVALID_MISSION_CURSOR`다. 응답과 오류는 모두 no-store이며 차단 사유·다른 제안자의 개인 내용을 포함하지 않는다.

## 방송 분석

`GET /api/v1/me/analytics?period=7&q=&from=&to=&cursor=&limit=20`은 로그인한 채널 소유자만 조회한다. `X-FRAME-USER-ID`가 현재 쿠키 계정과 다르면 409 `SESSION_CHANGED`다. 정상 응답은 no-store이고 같은 이름의 응답 헤더와 `userId`로 본인 범위를 확인한다. 다른 회원의 채널 ID나 경로를 지정해 조회할 수 없으며 익명은 401이다. 제품 기능을 끈 중계에는 collector·DB 집계·이 API를 추가하지 않는다.

기간은 한국 시간 오늘을 포함한 7일 또는 30일이다. `from`/`to`는 `YYYY-MM-DD`의 포함 범위이며 기본 기간 안에서만 좁힐 수 있다. 역순·존재하지 않는 날짜·기본 기간 밖의 날짜는 400 `INVALID_ANALYTICS_FILTER`다. `q`는 제목의 대소문자 무시 부분 검색(최대 120자), `limit`는 1~100이다. 검색과 날짜 조건을 요약·그래프·목록 모두에 똑같이 적용한다. 기간에 걸친 방송은 해당 날짜에 관측/집계한 구간만 합산해 모든 응답 지표가 같은 기간을 나타낸다. 목록은 첫 관찰 시각·UUID의 내림차순 keyset이고 커서는 계정·기간의 실제 날짜·검색·limit에 묶인다. 범위가 다른 커서는 400 `INVALID_ANALYTICS_CURSOR`이며 페이지를 바꾸어도 요약/일별 지표는 전체 선택 조건의 집계다.

응답은 `{userId,periodDays,fromDate,toDate,serverNowMs,collectionStartedAtMs,summary,daily,items,nextCursor}`다. 날짜는 포함 범위다. `summary`는 `{broadcastCount,broadcastDurationMs,observedDurationMs,averageConcurrent,peakConcurrent}`이며 `daily[]`에 같은 필드와 `date`를 넣는다. 선택 기간의 빈 날도 반환하고 관측 방송이 없으면 평균·최고는 null이다. 처음 한 점만 관찰한 방송은 방송 수 1·시간 0·평균 null·최고는 관측한 수치다. 동시 접속 0개인 표본 사이의 유효 구간은 평균과 최고가 0이며 미수집 null과 구분한다. `collectionStartedAtMs`는 해당 채널의 전체 최초 관찰 시각으로 검색/기간과 무관하며 아직 관찰한 방송이 없으면 null이다.

`items[]`는 `{id,broadcastId,path,title,startedAtMs,lastObservedAtMs,endedAtMs,status,endReason,broadcastDurationMs,observedDurationMs,averageConcurrent,peakConcurrent}`다. `id`는 서버 방송 instance UUID, `broadcastId`는 기존 32자리 송출 방송 ID다. `startedAtMs`는 **제품 통계가 실제 원본을 처음 관찰한 시각**이며 송출자가 알린 방송 시작 시각이 아니다. API 응답에 MediaMTX source ID/지문·시청자 계정·IP·장치·쿠키·이메일·송출 키를 넣지 않는다. 행에는 제목의 NUL을 U+FFFD로 바꾼 snapshot을 저장한다.

수집은 제품 전용 단일 worker가 5초 간격으로 한다. registry 이벤트와 미디어 요청 처리에서는 DB를 호출하지 않는다. 현재 채널의 연결 경로, registry instance, fresh MediaMTX 원본과 실제 관찰한 source 지문이 일치할 때만 수집한다. API만 재시작해 기존 RTMP 송출 원본이 새 registry 방송보다 오래된 경우에도 새 방송의 첫 실제 관찰부터 집계하며, 알림 전용 ‘원본 준비 시각이 방송 시작보다 10초 이상 오래되면 제외’ 규칙을 분석에 적용하지 않는다. 동시접속 수는 경로의 활성 HLS 세션·세션 없는 최근 미디어 요청과 실제 WebRTC reader의 합이다. WHEP 예약이나 녹화·화질 변환용 RTSP reader를 시청자로 더하지 않는다. **고유한 사람 수나 실제 영상 재생 시간의 증명이 아닌 추정 동시접속 수**다. 기존 경로 단위 집계 특성상 직전 방송의 세션이 `RELAY_SESSION_ACTIVE_MS`(기본 30초)까지 남을 수 있고, 같은 사람의 여러 탭도 별개 세션일 수 있다.

‘방송 시간’은 서버가 연속해서 fresh 원본을 관찰한 유효 표본 간격의 합이다. 한 간격은 최대 5초이고 이전 관찰과 15초를 넘게 떨어졌거나 DB 실패·원본 미확인·stale 상태를 사이에 두면 그 구간은 더하지 않는다. 수집 전, API 중단, 확인하지 못한 연결 공백을 방송 시간으로 복원하지 않는다. 현재 단계에서는 동시접속 집계가 가능한 그 구간과 같아 `broadcastDurationMs=observedDurationMs`다. 평균은 이전 표본의 동시접속 수×유효 구간을 누적한 `viewer_ms / observed_duration_ms`를 소수 둘째 자리까지 반올림한다. 날이나 방송의 평균을 다시 단순 평균하지 않는다. 유효 구간은 한국 시간 자정에서 나누어 일별 합과 요약·목록의 기간 합을 일치시킨다. 요약 방송 수는 선택 기간에 관찰된 서로 다른 방송 수이고, 일별 방송 수는 그 날 관찰된 방송 수다.

같은 instance의 짧은 원본 단절은 live 행을 보존한 채 관측 연속성만 중단한다. 재접속의 첫 일치 관찰에서는 source 지문과 기준 시각을 갱신하고 시간을 누적하지 않으며 그 다음 표본부터 재개한다. 동일 instance에서 source가 직접 교체되어도 교체 구간은 보간하지 않는다. registry에서 원래 instance가 사라지면 `ended/broadcast_ended`, 기존 채널의 연결 소유가 더 이상 맞지 않으면 `ended/channel_disconnected`로 최종 종료한다. 이전 API 프로세스의 live 행은 새 worker의 첫 DB 작업에서 `interrupted/server_restart`로 바꾸며, 종료 시각은 모두 마지막 실제 관찰 시각이다. 종료 행을 새 송출로 다시 열거나 다른 소유자에게 넘기지 않는다.

V13은 방송별 누적과 방송별 한국 날짜 집계의 두 테이블만 추가한다. 채널 UUID 이외의 회원·시청자 식별자를 집계 저장소에 보관하지 않는다. 채널의 현재 `id+stream_path`를 기존 행 갱신 전에도 확인한다. DB/MediaMTX 장애 때는 해당 worker의 집계를 건너뛰고 반복 상세 로그나 개인 원문을 출력하지 않는다. 읽기 DB 실패는 기존 503 `PRODUCT_UNAVAILABLE`이며 미디어 요청은 제품 집계 오류로 중단하지 않는다. 단일 API 프로세스가 한 제품 DB를 수집하는 현재 배치가 전제다. 여러 collector의 leader 선출·분산 집계는 구현하지 않는다. 도입 전 과거 방송과 5초보다 짧아 한 번도 관찰되지 않은 방송을 소급 생성하지 않는다.

## 비공개 녹화 관리

이 단계는 FRAME 서버가 기록한 파일의 소유자 전용 카탈로그다. OBS가 방송자 PC에 보관한 로컬 파일이나 공개 다시보기 발행 기능이 아니다. 기존 DVR·MediaMTX 출력 경로와 원본 파일을 바꾸지 않고, 제품 기능을 활성화했을 때만 전용 worker가 읽어서 V14의 관찰 창·파일 두 테이블에 보존한다. 기존 파일을 현재 채널에 소급 귀속하거나 파일을 실제로 삭제·이동·재인코딩하지 않는다.

`GET /api/v1/me/recordings?status=all&q=&cursor=&limit=20`은 로그인 소유자의 채널 파일만 반환한다. status는 all/ready/recording/ambiguous/missing/corrupt/hidden이며 all은 숨김을 제외하고 hidden은 숨긴 행의 원래 상태를 유지한다. q는 제목·화면 표시 파일명·원본 파일명의 대소문자 무시 부분 검색(최대 120자)이고 limit은 1~100이다. 목록은 기록 시각·UUID 내림차순이며 커서는 계정·상태·검색·limit에 묶인다. 잘못된 필터/커서는 400 INVALID_RECORDING_FILTER/INVALID_RECORDING_CURSOR다. GET 목록·상세와 PATCH에는 기존 X-FRAME-USER-ID 기대 계정 검사를 적용하며 다른 쿠키 계정이면 409 SESSION_CHANGED다.

목록 응답은 `{userId,items,nextCursor,storage,serverNowMs,collectionEnabled,retentionHours}`다. item은 `{id,title,displayName,recordedAtMs,durationMs,sizeBytes,status,version,hidden,readyPlayable,updatedAtMs,broadcastId,reason}`다. durationMs와 sizeBytes는 아직 확인하지 못했으면 null이다. 파일이 사라진 뒤 sizeBytes는 마지막 확인값을 유지한다. reason은 안전한 고정 사용자 설명이며 경로·원본 예외·source ID·송출 키·다른 계정의 정보를 넣지 않는다. displayName은 한국 날짜의 녹화_YYYY-MM-DD_HH-mm-ss.mp4이고 같은 이름을 복사해 검색할 수 있다.

`storage`는 `{knownFileCount,knownSizeBytes,availableFileCount,availableSizeBytes}`다. known은 숨김·누락을 포함한 전체 카탈로그와 최근 확인 크기 합, available은 누락이 아니며 실제 크기를 한 번 이상 확인한 파일들의 수·최근 확인 크기 합이다. ready만의 합이 아니며 녹화 중·경계 미확인·손상·숨김 파일도 실제 존재를 확인했다면 포함한다. 디스크 전체 용량이나 계정 할당량을 뜻하지 않는다. collectionEnabled는 현재 DVR와 recordDir 설정이 활성인지다. 설정이 꺼져 있어도 이전 카탈로그 조회와 숨김/복원을 보존하지만 readyPlayable은 false이고 실제 파일 전송을 막는다.

현재 저장소의 MediaMTX 설정과 로컬 실행기는 원본을 6시간 보관한다. retentionHours=6은 이 고정 기본 설정의 안내이며 제품 API가 보관 기간이나 디스크 한도를 집행하지 않는다. 7/30/90일 설정이나 100GB 할당량을 제공하지 않는다. 운영자가 MediaMTX 보관 설정을 변경하면 이 표시 계약도 함께 조정해야 한다. 보관 기간이 지나 실제 파일이 사라지면 missing으로 갱신하며, 목록을 복원해도 원본 파일을 되살리지 않는다.

`GET /api/v1/me/recordings/{id}`는 `{userId,item,serverNowMs}`다. `PATCH /api/v1/me/recordings/{id}`의 본문은 정확히 `{version,hidden:boolean}`이며 같은 상세 응답을 돌려준다. 숨김/복원의 실제 변경만 version을 1 증가시킨다. 같은 버전과 같은 hidden은 no-op 200, 버전 불일치는 값이 같아도 409 RECORDING_CONFLICT다. worker의 크기·상태·관찰 갱신은 이 사용자 편집 버전을 바꾸지 않는다. 파일은 원래 위치에 남고 숨기는 동안 전송은 차단한다. 동시 숨김/복원은 해당 행 잠금으로 직렬화한다. 다른 소유자나 없는 UUID는 404 RECORDING_NOT_FOUND다.

`GET` 및 `HEAD /api/v1/me/recordings/{id}/media?owner=<기대 계정 UUID>&download=0|1`은 쿠키 로그인과 필수 owner 기대 계정을 매 요청 확인한다. owner는 인증 토큰이 아니며 현재 쿠키 계정과 다르면 409 SESSION_CHANGED다. JSON 목록에 서버 파일 경로나 원본 이름을 노출하지 않고 이 UUID URL만 구성한다. ready이고 숨김이 아닐 때만 전달하며 나머지는 409 RECORDING_NOT_PLAYABLE다. download=1은 attachment이고 기본값 0은 inline video/mp4다. 모든 응답은 no-store다. 단일 bytes Range·suffix는 206/Content-Range를 제공하고 HEAD는 같은 헤더만 반환한다. 잘못된 단위·다중 범위·역순·범위 밖 요청은 416 및 bytes */size다. 전송은 전역 최대 4개·계정당 2개, 계정 rate limit을 넘으면 503/429와 Retry-After를 반환한다.

미디어 요청은 DB 소유권과 descriptor를 조회한 트랜잭션을 끝낸 뒤 파일을 열어 전달한다. 열린 전송 동안 DB 연결이나 행 잠금을 유지하지 않는다. 파일 크기·mtime·file key·완료 표시·전체 귀속을 다시 검사하고 달라지면 409 RECORDING_CHANGED다. 사라진 파일은 404 RECORDING_FILE_MISSING, 저장소 접근 실패는 503 RECORDINGS_UNAVAILABLE다. 파일 응답 헤더를 설정한 뒤 아직 전송하지 않은 상태에서 IO가 실패하면 헤더를 초기화해 JSON 오류의 길이를 오염시키지 않고, 이미 전송한 응답은 연결을 중단한다. 클라이언트가 파일명·상대/절대 경로를 지정하는 API는 없다.

관찰 worker는 2초 간격이다. fresh한 MediaMTX 원본과 registry의 실제 관찰 지문, immutable broadcast instance, 현재 채널 경로와 연결 기준 시각을 함께 확인해 그 시각부터 새 관찰 창을 연다. 6초보다 긴 worker 지연·stale/원본 미확인·source/instance/소유 연결 변경 때 이전 창을 마지막 확인 시각으로 닫고 새 관찰부터 다시 시작한다. API 재시작도 기존 열린 창을 마지막 확인 시각에서 닫는다. V13 분석 행이나 sender 시작 시각으로 녹화 경계를 추측하지 않는다. DB 작업은 미디어 요청·registry 이벤트 처리와 분리한다. 이 보수적 polling 방식은 짧은 방송이나 관찰 사이에 지난 경계를 복원하지 않는다.

새 관찰 창보다 이른 파일명 시각의 미등록 파일은 읽어서 현재 채널에 가져오지 않는다. 파일 하나의 소유 window_id와 path/file_name 고유 키는 처음 등록 후 다른 방송·계정으로 재배정하지 않는다. 파일명 시각부터 파싱한 전체 트랙 길이까지가 같은 관찰 창 안에 포함되고 양 끝 1초 여유까지 확인돼야 ready다. 첫 파일은 아예 등록되지 않을 수 있으며, 마지막 파일이나 방송·재접속·재시작 경계를 걸친 파일은 ambiguous로 차단될 수 있다. 오래된 완료 ready 파일의 검증된 구간은 이후 창 종료에도 보존한다. 기록된 파일의 실제 귀속이 불확실한 상황을 성공으로 처리하지 않는다.

완료 증거는 고정된 [MediaMTX 1.21.3 close 구현](https://github.com/bluenviron/mediamtx/blob/v1.21.3/internal/recorder/format_fmp4_segment.go)에 따른 mvhd duration 양수, fMP4 box 완결, 기존 RecordFile 영상 파서와 모든 트랙 시간 범위의 유효성, 최종 mtime 4초 경과다. 단순히 몇 초 동안 크기가 같다는 이유만으로 완료로 판단하지 않는다. 정상 ftyp/moov만 있고 첫 part를 기다리는 파일은 손상이 아니라 녹화 중이다. 최종 저장 표시 없는 정상 prefix가 닫힌 관찰 창에 남으면 ambiguous/최종 저장 확인 불가이며 구조적으로 잘못된 파일과 구분한다. 원본이 정상적으로 돌아오면 missing/corrupt/미완료 상태도 재검사하고 안전 조건을 다시 확인한다.

RecordedAssetProbe는 recordDir 아래의 정규 디렉터리·파일만 읽으며 realpath 일치와 NOFOLLOW_LINKS로 심볼릭 링크·junction·다른 경로 탈출을 거부한다. 설정된 디렉터리가 아직 없다고 API 시작을 실패시키거나 제품 코드가 임의로 녹화 디렉터리를 생성하지 않는다. 파일 상한은 64GB, top-level box 4096개, box별 메타데이터 8MB·총 16MB다. discovery는 한 경로에 최대 2048 entry·한 번에 16개 경로, FS 작업 목표 예산 1.5초이며 기존 카탈로그 검사는 오래 확인하지 않은 순서로 최대 24개씩 회전한다. 접근 거부·링크·스캔 예산 초과·DB 실패는 파일이 사라졌다고 확정하지 않고 이전 카탈로그를 보존하며 조회에 503을 반환한다. 단일 제품 API 프로세스가 공유 녹화 폴더를 관찰하는 현재 배치가 전제다.

## 공개 다시보기

V15 `product_vods`는 방송자가 **명시적으로 공개한 완료 녹화 하나**의 보관본을 관리한다. 기존 비공개 녹화 카탈로그·원본·MediaMTX DVR 설정은 그대로 둔다. raw 녹화의 기본 6시간 보관과 별도로 제품 API가 UUID 이름의 MP4를 `FRAME_PRODUCT_VOD_DIR`에 복제한다. 기본은 설정한 recordDir의 형제 `vod`이고 원본과 보관 폴더가 같거나 어느 쪽이 다른 쪽을 포함하면 시작을 거부한다. 원본 경로도 보관 경로도 없으면 `storageEnabled:false`로 조회하고 새 발행은 503 `VOD_STORAGE_UNAVAILABLE`다. 이 값은 경로 설정 여부이며 디스크 접근 가능·여유 공간의 보장이 아니다.

### 시청자 조회와 재생

| 요청 | 응답 |
| --- | --- |
| `GET /api/v1/vods?q=&channel=&cursor=&limit=20` | `{items,nextCursor,serverNowMs}` |
| `GET /api/v1/vods/{id}` | `{item,serverNowMs}` |
| `GET/HEAD /api/v1/vods/{id}/media` | `video/mp4`, 전체 200 또는 단일 bytes Range 206 |

이 GET/HEAD만 익명 공개한다. `Item`은 `{id,title,description,durationMs,sizeBytes,publishedAtMs,channel:{id,handle,displayName,avatarUrl}}`다. id는 서버 UUID이며 채널 정보는 현재 공개 프로필이다. avatarUrl은 아직 저장된 아바타가 없으므로 null이고 가짜 썸네일·조회수를 생성하지 않는다. 원본 이름·경로·recordingId·계정 이메일·source 지문을 공개 응답에 넣지 않는다. ready+public이고 현재 보관본 지문이 맞는 항목만 공개한다. 준비 중·실패·비공개·보관본 누락/변경·없는 UUID의 공개 상세와 미디어는 모두 404 `VOD_NOT_FOUND`다.

q는 제목·채널 표시 이름의 대소문자 무시 부분 검색, 최대 120자다. channel은 소문자 채널 handle이며 과거 예약 주소도 같은 채널 UUID에 연결한다. limit은 1~100이다. 게시 시각·UUID 내림차순 keyset cursor는 검색·채널·limit에 묶인다. 유효하지 않은 검색은 400 `INVALID_VOD_FILTER`, 다른 조건의 cursor는 `INVALID_VOD_CURSOR`다. DB에 행은 남았지만 보관본이 없는 항목은 목록에서 제외하므로 한 페이지의 items가 limit보다 적어도 nextCursor가 있을 수 있다.

미디어는 DB 공개 상태를 확인한 트랜잭션을 끝낸 뒤 열어 전송한다. 매 새 요청에서 공개 여부와 정규 파일의 size/mtime/file key를 확인한다. HEAD는 같은 길이·미디어 헤더와 빈 본문을 반환한다. Range의 단일 구간·suffix는 206/Content-Range, 잘못된 단위·다중·역순·범위 밖은 416 및 `bytes */size`다. 모든 정상·오류 응답은 no-store다. 전역 8개/IP당 4개 전송 상한은 503 `VOD_STREAM_BUSY`, IP 전송 요청 rate 제한은 429 `VOD_RATE_LIMITED`와 Retry-After다. 헤더 전 IO 실패는 JSON 503 `VOD_MEDIA_UNAVAILABLE` 또는 파일 없음 404로 답하고 이미 시작한 응답은 연결을 중단한다.

비공개 전환 뒤 **새로운 목록·상세·미디어 요청**은 404다. 이미 전달한 바이트나 허용돼 진행 중인 전송까지 회수하지 않는다. 페이지는 재조회로 공개 철회를 감지하지만 이미 내려받은 파일을 제거하는 기능은 아니다.

### 방송자 발행과 관리

| 요청 | 본문 및 결과 |
| --- | --- |
| `GET /api/v1/me/vods?status=all&q=&cursor=&limit=20` | `{userId,items,nextCursor,serverNowMs,storageEnabled}` |
| `GET /api/v1/me/vods/{id}` | `{userId,item,serverNowMs,storageEnabled}` |
| `GET /api/v1/me/vods/by-recording/{recordingId}` | 같은 상세 envelope, 기존 발행이 없으면 item:null |
| `POST /api/v1/me/vods` | 정확히 `{recordingId,title,description}`, 새 요청 202 preparing, 동일 영수증 200 |
| `PATCH /api/v1/me/vods/{id}` | 정확히 `{version,title,description,visibility}`; public/private 설정, 상세 200 |
| `POST /api/v1/me/vods/{id}/retry` | 정확히 `{version}`; failed 항목을 같은 UUID로 202 preparing |

위 API는 쿠키 로그인·소유 채널로 한정하고 쓰기는 기존 CSRF/Origin 검사를 적용한다. `X-FRAME-USER-ID`를 보내면 현재 쿠키 계정과 일치해야 하며 다르면 409 `SESSION_CHANGED`다. 다른 회원의 VOD 상세/수정과 다른 회원·없는 원본으로 새 발행은 404다. 다른 회원의 by-recording 조회는 item:null이다. title은 1~100자 한 줄, description은 0~2,000자 여러 줄이며 NFC·CRLF→LF·앞뒤 공백을 정규화한다. 정해진 필드 이외 값·잘못된 타입은 400 `INVALID_VOD_INPUT`다.

`OwnItem`은 공개 Item 필드에 `{recordingId,status,visibility,published,available,version,reason,createdAtMs,updatedAtMs}`를 더하며 publishedAtMs는 아직 공개된 적 없으면 null이다. recordingId는 카탈로그가 삭제되면 null이 될 수 있어도 보관본을 지우지 않는다. status는 preparing/ready/failed, visibility는 원하는 public/private 설정, available은 ready 보관본의 현재 지문 확인 결과다. published는 세 조건 ready+public+available이 모두 맞을 때만 true다. reason은 경로·예외·비밀값을 포함하지 않는 고정 설명이다. owner 목록 status는 all/preparing/ready/failed, q는 제목 부분 검색이며 cursor는 계정·상태·검색·limit에 묶인다.

새 요청은 원본이 소유자의 ready·비숨김 파일이고 실제 완료/귀속 검증이 맞을 때만 받는다. 한 원본에는 unique recording_id로 다시보기를 하나만 만든다. 같은 정규화 제목·설명으로 재확인하면 기존 행을 먼저 반환하므로 원본이 이미 사라졌어도 중복 복제를 만들지 않는다. 기존 행에 다른 본문을 보내면 409 `VOD_ALREADY_EXISTS`이며 PATCH를 사용한다. 계정당 preparing 최대 2개는 503 `VOD_PREPARATION_BUSY`와 Retry-After다. 발행·retry 요청 rate 제한은 429다. 202는 준비 완료가 아니며 owner 상세로 상태를 확인한다. 응답을 받지 못한 네트워크/503 상황은 by-recording으로 결과를 먼저 확인하고 무조건 새 POST를 반복하지 않는다.

PATCH와 retry는 행 잠금·version 검사로 직렬화하며 버전이 다르면 409 `VOD_CONFLICT`다. 실제 제목·설명·공개 설정 변경과 retry만 version을 증가시키고 같은 값의 PATCH는 no-op 200이다. worker의 준비 완료/실패는 이 편집 버전을 바꾸거나 새 제목·설명·visibility를 이전 snapshot으로 덮지 않는다. preparing 중 private로 바꾸면 완료 뒤에도 비공개다. ready 보관본을 다시 공개하려면 현재 보관 파일이 있어야 하며 없으면 409 `VOD_ARCHIVE_UNAVAILABLE`다. **비공개 전환은 원본·보관 디스크가 없어도 DB에서 처리**한다.

이미 준비한 보관본은 raw 원본이 숨겨지거나 missing이 되거나 6시간 TTL로 삭제되어도 조회·수정·공개/비공개를 계속할 수 있다. 원본 숨김은 별도 VOD의 공개 철회를 대신하지 않는다. 기존 발행 by-recording 조회 역시 원본의 현재 상태에 의존하지 않는다. failed만 retry 가능하고 나머지는 409 `VOD_NOT_FAILED`다. retry는 현재 원본을 다시 검증하고 길이·크기 snapshot을 새로 저장한다. 재시도할 원본이 현재 불가하면 409 `VOD_SOURCE_UNAVAILABLE`이며 자동으로 다른 녹화에 바꾸지 않는다.

### 보관 worker와 재시작

제품 API 한 프로세스의 단일 worker가 매초 준비 행을 하나씩 처리한다. HTTP 요청이나 DB 트랜잭션/커넥션을 붙잡고 복사하지 않는다. 소유권·완료 증거·크기/mtime/file key·귀속 경계를 다시 확인한 원본을 읽기 전용으로 열어 앱 소유 UUID.part에 복사하고 SHA-256을 계산한다. fsync·원본 재검증 뒤 원자 rename으로 UUID.mp4를 만들고 최종 파일을 다시 해시 검사한 뒤에만 DB ready로 전환한다. 관찰 창의 현재 끝이 계속 늘어나는 상황을 파일 변경으로 오인하지 않는다. 복사·검증 읽기 루프는 중단 요청과 각각 2분 예산을 확인한다. FS/DB 오류는 공개 성공으로 표시하지 않는다.

파일 접근은 root/정규 파일의 realpath 일치와 NOFOLLOW_LINKS를 검사하며 심볼릭 링크·junction·외부 경로를 거부한다. 클라이언트는 경로/파일명을 지정하지 못한다. 재시작은 이전 preparing을 failed/준비 중단으로 바꿔 소유자가 재시도하게 한다. 자신이 만든 UUID.part만 정리하고 원본이나 폴더 전체를 재귀 삭제하지 않는다. crash 뒤 남은 **아직 ready가 아닌 같은 UUID 보관물**은 재시도 때 검증한 원본과 같으면 재사용하고 크기/해시가 다르면 새 part로 원자 교체한다. 이미 ready인 공개/비공개 보관본은 복사 worker 대상이 아니다.

현재는 녹화 파일 하나를 같은 원본 화질로 발행한다. 여러 파일 병합·별도 FFmpeg 재인코딩·VOD 화질 래더·썸네일 생성·조회수 집계·결제·CDN·분산 worker는 추가하지 않는다. 보관본 자동 만료·사용자 삭제·용량 할당 API도 없으며 보관 용량은 운영자가 관리한다. 단일 제품 API 인스턴스 전제이며 여러 API의 worker를 같은 DB/폴더에 동시에 연결하지 않는다.

## 공개 클립

V16 `product_clips`는 방송자 본인의 **공개된 ready 다시보기에서 선택한 5~60초 구간**을 실제 별도 MP4로 만든다. 시청자 클립 생성·실시간 DVR 잘라내기·외부 파일 업로드는 포함하지 않는다. 원본 VOD와 같은 채널만 허용하고 `(source_vod_id,channel_id)` 복합 FK가 이를 DB에서도 보장한다. 원본 VOD 메타데이터를 삭제하면 연결된 클립 메타데이터도 연쇄 삭제하며, API는 원본/보관 파일을 임의 삭제하지 않는다.

### 공개 조회와 원본 공개 정책

| 요청 | 응답 |
| --- | --- |
| `GET /api/v1/clips?q=&channel=&cursor=&limit=20` | `{items,nextCursor,serverNowMs}` |
| `GET /api/v1/clips/{id}` | `{item,serverNowMs}` |
| `GET /api/v1/clips/{id}/media` | `video/mp4`, 단일/접미 Range·HEAD 지원 |

공개 항목은 `{id,title,description,durationMs,sizeBytes,publishedAtMs,channel:{id,handle,displayName,avatarUrl},source:{id,title,handle},startMs,endMs}`다. 공개에는 `clientRequestId`·계정 ID·원본 경로·보관 지문을 전달하지 않는다. 검색 q는 제어 문자 없는 최대 120자이며 제목과 채널 이름을 검색한다. channel은 현재/예약된 채널 @아이디이고 limit은 1~100이다. 최신 공개 시각/UUID keyset cursor는 검색·채널·limit 문맥에 묶는다. 모든 응답은 `no-store`다.

클립의 `ready/public`, 클립 보관 파일의 현재 지문 일치, **원본 VOD 행의 ready/public**이 모두 맞아야 익명 목록·상세·미디어·HEAD를 제공한다. 원본을 비공개로 바꾸면 파생 클립의 새 공개 요청도 404다. 원본 재공개는 자체 공개 범위가 public인 클립을 다시 노출하며, 클립을 직접 private으로 바꾼 선택은 유지한다. 원본 VOD의 물리 파일만 없어지는 것은 이미 생성한 독립 클립의 공개를 철회하지 않는다. 이미 전달한 바이트와 진행 중인 허용 전송은 회수하지 않는다. 플레이어는 공개 상태 재조회로 철회를 확인해 재생을 정리한다.

### 방송자 생성·관리·접수 확인

| 요청 | 응답 |
| --- | --- |
| `GET /api/v1/me/clips?sourceVodId=&status=all&q=&cursor=&limit=20` | `{userId,items,nextCursor,serverNowMs,storageEnabled}` |
| `GET /api/v1/me/clips/{id}` | `{userId,item,serverNowMs,storageEnabled}` |
| `GET /api/v1/me/clips/by-request/{clientRequestId}` | 같은 계정의 접수 결과 또는 `item:null` |
| `POST /api/v1/me/clips` | `{sourceVodId,startMs,endMs,title,description,clientRequestId}` → 새 접수 202, 같은 접수 200 |
| `PATCH /api/v1/me/clips/{id}` | `{version,title,description,visibility}` → 200 |
| `POST /api/v1/me/clips/{id}/retry` | `{version}` → 202 |

소유자 항목은 공개 항목의 `publishedAtMs`를 nullable로 바꾸고 `sourceVodId,clientRequestId,status,visibility,published,available,sourcePublished,version,reason,createdAtMs,updatedAtMs`를 더한다. source는 원본이 비공개여도 본인 관리에서 유지한다. `status=preparing|ready|failed`, `visibility=public|private`이며 `available`은 클립 보관 파일 존재/지문, `sourcePublished`는 원본 DB ready/public, `published`는 이들을 합친 실제 공개 가능 상태다. preparing의 sizeBytes는 0, durationMs는 선택 길이이며 ready 뒤에는 실제 출력 크기/길이다. 202는 준비 접수이고 공개 성공을 뜻하지 않는다. 공개 예정이어도 원본이 비공개면 published는 false다.

시간 값은 반올림 없는 정수 ms이며 `0 ≤ startMs < endMs ≤ 원본 길이`, `5,000 ≤ endMs-startMs ≤ 60,000`이다. 제목은 1~100자 한 줄, 설명은 0~2,000자 여러 줄이며 NFC·CRLF와 앞뒤 공백을 정규화한다. 미정의 필드/잘못된 타입은 400이다. 새 생성/failed 재시도에는 본인 원본 VOD의 ready/public과 실제 보관 지문을 재검사한다. 원본이 남의 채널이면 404, 비공개·파일 불가 상태면 409 `CLIP_SOURCE_UNAVAILABLE`다. 한 계정의 preparing은 최대 2개이고 초과는 503 `CLIP_PREPARATION_BUSY`/Retry-After다. 생성과 재시도는 채널 행 잠금으로 이 상한을 직렬화한다.

clientRequestId는 계정/채널 범위 UUID다. 최초 source·범위·정규화 제목/설명을 별도 snapshot으로 보존해, 메타데이터 수정이나 원본 비공개 이후에도 동일 요청은 같은 receipt를 반환한다. 다른 본문으로 UUID를 재사용하면 409 `CLIP_REQUEST_CONFLICT`다. 불확실한 POST는 자동 재전송하지 않고 by-request GET부터 확인한다. 수정/재시도는 현재 version만 받고 충돌은 409 `CLIP_CONFLICT`다. 비공개 전환은 클립 파일·원본 파일·원본 공개 상태와 무관하게 DB에서 처리한다. 기존 쿠키 로그인·CSRF·Origin을 적용하고 `X-FRAME-USER-ID`가 현재 쿠키 계정과 다르면 409 `SESSION_CHANGED`다. 다른 계정의 관리 상세/수정은 404이고 receipt는 item:null이다.

### 인코딩과 보관

`FRAME_PRODUCT_CLIP_DIR`은 raw/VOD 폴더와 서로 포함하지 않는 별도 쓰기 폴더다. 기본은 VOD 폴더의 형제 `clips`다. 경로나 FFmpeg 설정이 없으면 storageEnabled:false이며 디스크 여유/실행 파일 존재의 보장은 아니다. 기존 `RELAY_FFMPEG`를 재사용하고 새 미디어 라이브러리·ffprobe 실행 파일을 요구하지 않는다.

단일 worker는 source 권한/범위/원본 지문과 SHA-256을 확인한 뒤 FFmpeg를 셸 없이 인자 배열로 실행한다. H.264/AAC 재인코딩과 accurate input seek로 선택 구간을 만들고 해상도를 확대하지 않는다. 디코더/인코더는 각 1 thread, 전체 준비 120초·출력 512 MiB 상한을 두며 종료/시간 초과 시 자신이 시작한 프로세스만 정리한다. `-c copy`는 정확한 시작 구간을 보장하지 않으므로 쓰지 않는다. [FFmpeg 공식 seek 문서](https://ffmpeg.org/ffmpeg.html#Main-options)

UUID.part는 정상 ftyp/moov/mdat와 bounded mvhd 메타데이터·양수 길이·요청 길이와 500ms 이내·크기·SHA를 검증한다. 원본 권한과 지문/내용을 다시 확인한 뒤 원자 이동하며, DB 완료는 작업 중 편집한 제목·설명·공개 범위/버전을 덮어쓰지 않는다. 메타데이터 읽기를 제외한 인코딩·해시·영상 전송 동안 DB 연결을 유지하지 않는다. realpath·NOFOLLOW·정규 UUID 파일 이름을 검사하고 원본을 쓰거나 경로를 클라이언트에서 받지 않는다. 재시작의 preparing은 failed로 바꿔 명시적 재시도하게 하며 자신 소유 UUID.part만 정리한다. 미완료 UUID 출력은 같은 원본에서 안전하게 다시 생성하지만 ready 보관본은 인코더 대상이 아니다.

현재 단일 API 인스턴스 전제이며 전용 보관본 자동 만료·삭제/용량 할당·썸네일·조회수·포인트 적립은 추가하지 않는다. VOD·클립의 개인 시청 기록·저장 위치는 위 V17 시청 기록 계약을 따른다. DB와 클립 파일은 함께 보존한다. raw의 기존 6시간 보관·MediaMTX·라이브/DVR·V1~V16 원문은 유지한다.

## 검증

기존 기본 회귀 검사에는 외부 DB·Redis가 필요하지 않다.

```powershell
cd apps/api
./gradlew.bat test bootJar
```

실제 PostgreSQL·Redis 통합 검사는 저장소 밖 검증 설정 파일의 경로를 지정한다. 테스트는 루프백 `127.0.0.1`의 FRAME 전용 포트 `15432`(네이티브) 또는 `25432`(Docker), DB 이름 `frame_product_verify` 또는 고유 접미사가 붙은 검증 DB인지 먼저 검사한다. 쿼리 매개변수·URL 안의 자격증명·외부 호스트·사용자 DB `frame_product`는 허용하지 않는다. 해당 DB의 임의 생성 스키마와 임의 Redis namespace만 사용하며, 종료 시 생성한 스키마·namespace 키만 정리한다. 실제 DB의 사용자·스키마·운영자 키를 읽거나 변경하지 않는다. 설정에는 `verifyDbUrl`, `dbUsername`, `dbPassword`, `redisHost`, `redisPort`, `redisPassword`가 필요하다.

Flyway는 제품 기능을 활성화한 Spring Boot의 시작 과정에서 `db/migration`을 적용한다. 현재 V1(회원·채널·팔로우), V2(가입 동의), V3(방송 예약), V4(시청 기록), V5(채널 프로필·주소 예약·신고 접수), V6(운영자 플래그·신고 관리), V7(개인 알림·전송 표식·시작 기준 시각), V8(채팅 정책·계정 차단), V9(방송 투표·선택지·계정별 표), V10(비공개 질문·답변·명시적 공개 고정), V11(채널 포인트·원장·보상·교환 요청), V12(비공개 무료 미션·상태 이력), V13(방송별·일별 실제 관찰 집계), V14(비공개 녹화 관찰 창·파일 카탈로그), V15(명시적 공개 다시보기·별도 보관본 메타데이터), V16(원본 공개에 연동한 클립·생성 요청 snapshot·구간·인코딩 상태), V17(다시보기·클립의 시청 위치·완료·행 버전·삭제 epoch)을 사용한다. `validate-on-migrate: true`, `clean-disabled: true`, `baseline-on-migrate: false`를 명시한다. 적용한 SQL은 수정하지 않고 새 `V18__설명.sql` 같은 다음 버전을 추가한다. Redis는 Flyway 관리 대상이 아니다. 기존 Flyway 기록이 없는 비어 있지 않은 스키마를 자동으로 기존 운영 DB라고 간주하거나, checksum 오류를 자동으로 `repair`해서 넘기지 않는다.

`ProductMigrationIntegrationTest`는 별도 PostgreSQL DB의 임의 생성 스키마에서 빈 DB의 V17까지 적용·재시작 시 미적용, V1 데이터의 최신 업그레이드 보존·기존 동의 NULL 유지, V3·V4에서 최신으로 업그레이드한 뒤 기존 방송 예약·시청 기록·채널 생성일 보존과 주소 백필·삭제 후 예약 동작, V5 신고의 원문·시각 보존과 운영자 자동 승격 없음, V6 알림 설정 보존·시작 기준 생성·과거 알림 미생성, V7 프로필·팔로우·알림 확인 상태 보존과 기본 채팅 정책 추가, V8 기존 정책 보존과 투표 단일 슬롯·계정별 한 표·선택지 복합 FK, V9 투표·선택지·표 보존과 질문 요청 멱등 키·단일 고정·답변 시각 제약, V10 기존 비공개 답변 보존과 빈 포인트 저장소·음수 잔액·1회 신청·중복 환불 제약, V11 잔액·부분 시청·원장·보상 신청 보존과 미션 요청/기한/이력 고유 제약, V12 미션·이력 보존과 빈 방송 분석 저장소·관찰 제약·FK 및 채널 삭제 연쇄, V14 녹화 관찰 창·파일 보존과 V15 빈 다시보기 저장소·원본당 고유 제약·ready의 검증 해시 필수 조건, V15 VOD 보존과 빈 클립 저장소·요청 UUID 고유 제약·채널/원본 복합 FK·구간/완료 해시 제약·원본 삭제 연쇄, V16 라이브 시청 기록 보존·기본 epoch와 종류별 형태·위치/완료/버전 제약·채널 삭제 후 snapshot 보존·계정 삭제 연쇄, 임시 복사 SQL 변조 시 checksum 검증으로 후속 V18 DDL 차단을 검사한다. 이 검사는 비밀 설정의 `verifyDbUrl` 중 루프백 주소와 `frame_product_verify` 또는 고유 접미사를 붙인 이름만 허용하며, 실행 시 생성한 `migration_verify_*` 스키마만 정리한다. 실제 DB와 저장소의 V1~V16 SQL은 변경하지 않는다. `ProductStorageDisabledTest`는 DB·Redis가 연결되지 않아도 제품 기능 비활성 상태의 미디어 서버가 해당 구성 요소 없이 시작되는지 검사한다.

```powershell
$env:FRAME_PRODUCT_TEST_CONFIG = '<저장소 밖 검증 설정 JSON 경로>'
./gradlew.bat test --tests 'frame.api.account.*'
```

HTTP 쿠키·CSRF·Origin, 긴 한글 비밀번호, 중복 가입 트랜잭션, 실제 DB의 팔로우·알림·집계, 채널 소유권, 명시적 OBS 증명과 경로 독점, 운영자 API 격리, Redis 세션의 서버 재시작 복원, 절대 만료, 로그아웃 후 쿠키 재사용 거절을 확인한다. 실제 Redis를 중지하지 않고 별도 테스트 인스턴스의 Redis 포트만 닫힌 포트로 바꿔, 기존 로그인 쿠키·비로그인 초기화 요청의 503과 같은 쿠키를 보낸 기존 미디어 상태·목록 요청의 정상 응답도 확인한다.
