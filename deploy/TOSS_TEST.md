# 토스페이먼츠 테스트 결제

아래 계정 멤버십과 구형 운영자 후원 테스트는 서로 다른 인증·키·원장을 사용한다. 둘 다 테스트 키만 받으며 `live_*` 키는 받지 않는다. 결제창에서 돌아왔다는 이유로 결제나 가입 성공을 표시하지 않는다.

## 계정 멤버십 자동결제

로그인한 방송자는 `/_frame/studio/members`에서 월 가격·혜택과 가입 허용 여부를 저장한다. 다른 로그인 시청자는 해당 채널의 멤버십 버튼에서 월 가격과 자동결제에 동의한 뒤 토스 카드 등록창으로 이동한다. 가입자는 결제 내역에서 멤버십과 청구 상태를 확인하고 해지할 수 있다. 해지는 다음 자동 청구를 중단하며 결제한 기간은 유지한다. 결제 취소·환불과는 다르다.

빌링에는 API 개별 연동용 **같은 세트의 `test_ck_*`와 `test_sk_*`**가 필요하다. 일반 결제위젯의 `test_gck_*`/`test_gsk_*`와 혼합하거나 서로 변환하지 않는다. 실제 상점 테스트 키는 [토스 자동결제 연동 안내](https://docs.tosspayments.com/guides/v2/billing/integration)의 API 키 메뉴에서 확인한다.

저장소 밖 `%LOCALAPPDATA%/Frame/obs-local/toss-billing-test.json`에 `clientKey`, `secretKey` 두 필드를 저장한다. 키는 명령줄·Git·브라우저 환경 파일·로그에 넣지 않는다. 이 파일이 없으면 플랜 편집과 기존 내역 조회는 가능하지만 새 가입 결제는 준비되지 않은 상태로 표시한다. 실행기는 이 파일을 `FRAME_MEMBERSHIP_TEST_ENABLED`, `FRAME_MEMBERSHIP_TEST_CLIENT_KEY`, `FRAME_MEMBERSHIP_TEST_SECRET_KEY`로 Spring에 전달한다. Docker 제품 설정을 선택한 같은 셸에서 API만 교체한다.

```powershell
$env:FRAME_PRODUCT_CONFIG = Join-Path $env:LOCALAPPDATA 'Frame/product-docker/config.json'
node server/obs-local.mjs restart-api
```

Linux에서도 위 세 환경 변수를 비공개 환경 파일에 설정할 수 있다. 클라이언트 키만 본인 가입 준비 응답에 전달하고 시크릿 키·빌링 키·인증 키 원문은 공개하지 않는다. 회원 UUID와 채널 UUID는 PostgreSQL 원장으로 연결한다. 원문 `authKey`는 단일 worker의 제한된 메모리에서만 처리하고, DB에는 해시만 남긴다. `billingKey`는 갱신에 필요한 비공개 DB 값으로 저장하므로 DB·백업 접근도 비밀 정보로 관리해야 한다.

첫 결제와 후속 월 청구 모두 서버에 저장된 가격·주문번호·멱등키를 사용한다. 서버가 조회한 검증된 `BILLING`/`KRW`/`DONE` 응답과 일치하는 금액만 이용 기간에 반영한다. 가격을 수정해도 기존 가입자의 금액을 자동 인상하지 않는다. 가입을 중지하면 기존 구독의 다음 청구도 중단하며 다시 열어도 해지를 되돌리지 않는다. 모호한 청구는 같은 주문을 조회하고 새 청구로 대체하지 않는다. 현재 단일 API worker 기준이며 여러 API 프로세스의 병렬 청구는 지원하지 않는다.

검증용 `frame.membership.test-api-base`는 소유한 literal `http://127.0.0.1:<높은 포트>` 수신기에만 설정할 수 있다. 기본은 고정된 토스 HTTPS API이고 로컬 실행기는 이 예외를 전달하지 않는다. 모의 PG·SDK spy 검증은 실제 토스 테스트 상점의 카드 등록·청구 완료 검증과 별도로 기록한다. 결과와 재현 명령은 [제품 검증 기록](../verification/product/REPORT.md)을 따른다.

## 구형 운영자 후원 테스트

다음 내용은 운영자 Bearer·파일 원장을 사용하는 기존 후원 시험용이다. 제품 모드의 회원 멤버십에는 사용하지 않는다.

## 로컬 설정

비밀 설정 파일은 저장소 밖 `%LOCALAPPDATA%/Frame/obs-local/toss-test.json`이다. 이 파일을 저장소·프론트 환경변수·로그에 복사하지 않는다.

| 필드 | 용도 |
| --- | --- |
| `clientKey` | 현재 결제창형 위젯에는 `test_gck_*`. SDK 초기화에 사용하는 공개 키 |
| `secretKey` | 해당 클라이언트 키와 같은 세트의 `test_gsk_*`. Spring의 승인 요청에만 사용 |
| `securityKey` | 서버에만 보관. 현재 웹훅·지급대행 기능은 없으므로 승인 인증이나 클라이언트 키로 사용하지 않음 |

현재 프론트 결제창은 토스 SDK v2의 결제창형 위젯을 사용하므로, 전체 흐름에는 같은 세트의 `test_gck`+`test_gsk`가 필요하다. 백엔드의 승인 기능은 API 개별 연동용 `test_ck`+`test_sk`도 허용하지만 현재 위젯 화면에서는 이 조합을 사용하지 않는다. 키를 다른 값에서 유추하거나 혼합하지 않는다.

공용 체험용 테스트 키를 사용하면 본인 개발자센터의 테스트 결제 내역에는 나타나지 않는다. 본인 상점의 내역까지 확인하려면 로그인한 개발자센터에서 해당 상점의 결제창형 테스트 키 쌍을 발급받아 설정한다. [공식 FAQ의 API 키 안내](https://docs.tosspayments.com/resources/faq)

설정을 바꾼 뒤 방송이 없는 상태에서 로컬 서버를 재시작한다.

```powershell
node server/obs-local.mjs stop
node server/obs-local.mjs start
```

실행기가 비밀 파일을 읽어 `TOSS_TEST_*` 환경변수로 Spring에 전달한다. 주문 저장 위치는 `%LOCALAPPDATA%/Frame/obs-local/payments/orders.json`이다. 키 값은 명령줄에 넣지 않는다.

브라우저는 `http://127.0.0.1:5360/_frame/api/payments/*`로 요청한다. 웹 개발 서버는 이를 Spring의 `/api/payments/*`로 프록시하고, 로컬 운영자의 인증 토큰을 서버 쪽에서 붙인다. 이 방식은 이 PC의 개발 연결이다. 인터넷 서비스에는 구매자 계정 인증과 채널 소유권 제품 API가 필요하다.

## API 계약

모든 요청은 현재 로컬 운영자의 Bearer 인증을 요구하고, 응답은 `Cache-Control: no-store`다. 다른 토큰의 주문은 목록과 상세 조회에서 보이지 않는다.

| 요청 | 결과 |
| --- | --- |
| `GET /api/payments/config` | `{enabled,environment:"test",clientKey,currency:"KRW",minAmount:1000,maxAmount:10000000}`. 설정이 불완전하면 `enabled:false`, `clientKey:null` |
| `POST /api/payments/orders` | `{channel,kind,amount,message?,videoUrl?,start?}`를 검증하고 서버 주문번호·금액·주문명·고객 키를 생성. 정상 201 |
| `POST /api/payments/confirm` | `{orderId,paymentKey,amount}`. 소유자와 저장된 금액·결제 키를 검증한 뒤 공식 승인 API 호출. 검증된 결제만 정상 200/DONE |
| `GET /api/payments/orders/{orderId}` | 본인 주문의 상태·금액·주문명·승인 시각·결제 방법·영수증 주소 |
| `GET /api/payments/orders` | `{items,nextCursor:null}`. 본인 주문 최신 200개 |

현재 `channel`은 `spring`, `green`, `pado`, `seojae`, `moa`만 허용한다. `kind`는 `메시지`, `음성`, `영상`이다. 금액은 1,000~10,000,000원의 정수만 받으며 영상 주소·시간과 음성 메시지도 서버에서 검증한다.

반환 주문의 공통 필드는 `orderId`, `orderName`, `amount`, `currency`, `customerKey`, `status`, `channel`, `kind`, `createdAt`, `approvedAt`, `method`, `receiptUrl`이다. 주문 소유자 해시·토스 결제 키·승인 멱등키는 반환하지 않는다. 고객 키는 개인 정보가 아닌 운영자 식별자의 해시에서 만든 불투명 식별값이다.

주문 상태는 `READY`, `CONFIRMING`, `DONE`이다. 통신 오류나 모호한 승인 응답을 결제 완료로 취급하지 않는다. 리다이렉트 금액은 서버에 저장된 금액과 반드시 같아야 한다.

## 승인과 오류 처리

- 토스 승인 호출 전에 `paymentKey`와 안정적인 `Idempotency-Key`를 파일에 원자적으로 저장한다. 저장 실패 시 승인 API를 호출하지 않는다.
- 같은 주문의 동시 승인은 409 `PAYMENT_PROCESSING`으로 답한다. 완료된 동일 주문·결제 키의 재요청은 외부 승인을 다시 호출하지 않는다.
- 실패·타임아웃·서버 재시작 후 재시도는 저장된 동일 키와 멱등키를 사용한다. 주문에 다른 결제 키를 끼워 넣을 수 없다.
- HTTP 200뿐 아니라 토스 응답의 주문번호·결제 키·통화·금액·`DONE` 상태를 모두 확인한다. 입금 대기 등 다른 상태는 완료가 아니다.
- 외부 요청 대상은 `https://api.tosspayments.com/v1/payments/confirm`으로 고정하고 리다이렉트를 따라가지 않는다. 응답 본문까지 12초 기한을 적용한다.
- 영수증은 토스의 HTTPS 주소만 반환한다. 앱이 외부 영수증 주소를 대신 가져오지 않는다.
- 환불·취소·정산·웹훅은 이번 연결에 포함되지 않는다. 해당 버튼에서 임의 성공이나 가짜 영수증을 만들지 않는다.

## 검증

```powershell
cd apps/api
./gradlew.bat test --tests 'frame.api.payments.*'
```

로컬 HTTP 모의 서버로 금액·소유자·큰 정수 조작, 같은 주문 중복 승인, 다른 결제 키 재사용, 재시작 후 같은 멱등키 재시도, 잘못된 200 응답, 리다이렉트, 동시 승인, 파일 저장 실패, 느린 본문 기한, 인증과 비밀 값 응답 제외를 검사한다. 실제 토스 테스트 결제창 검증은 별도로 기록한다.

공식 근거: [결제창형 연동](https://docs.tosspayments.com/guides/v2/payment-widget/integration-window), [API 키](https://docs.tosspayments.com/reference/using-api/api-keys), [승인 API](https://docs.tosspayments.com/reference#결제-승인), [Basic 인증과 멱등키](https://docs.tosspayments.com/reference/using-api/authorization).
