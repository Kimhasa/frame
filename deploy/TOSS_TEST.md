# 토스페이먼츠 테스트 결제

이 연결은 테스트 키만 받는다. `live_*` 키나 서로 다른 종류의 클라이언트·시크릿 키 조합은 결제 준비 상태가 되지 않는다. 브라우저 결제창 인증 후 Spring이 토스 승인 응답을 확인해야만 주문을 `DONE`으로 저장한다.

## 로컬 설정

비밀 설정 파일은 저장소 밖 `%LOCALAPPDATA%/Frame/obs-local/toss-test.json`이다. 이 파일을 저장소·프론트 환경변수·로그에 복사하지 않는다.

| 필드 | 용도 |
| --- | --- |
| `clientKey` | 현재 결제창형 위젯에는 `test_gck_*`. SDK 초기화에 사용하는 공개 키 |
| `secretKey` | 해당 클라이언트 키와 같은 세트의 `test_gsk_*`. Spring의 승인 요청에만 사용 |
| `securityKey` | 서버에만 보관. 현재 웹훅·지급대행 기능은 없으므로 승인 인증이나 클라이언트 키로 사용하지 않음 |

현재 프론트 결제창은 토스 SDK v2의 결제창형 위젯을 사용하므로, 전체 흐름에는 같은 세트의 `test_gck`+`test_gsk`가 필요하다. 백엔드의 승인 기능은 API 개별 연동용 `test_ck`+`test_sk`도 허용하지만 현재 위젯 화면에서는 이 조합을 사용하지 않는다. 키를 다른 값에서 유추하거나 혼합하지 않는다.

현재 로컬 설정은 공식 문서의 공용 체험용 테스트 키다. 이 키로 결제 흐름은 확인할 수 있지만 본인 개발자센터의 테스트 결제 내역에는 나타나지 않는다. 본인 상점의 내역까지 확인하려면 로그인한 개발자센터에서 해당 상점의 결제창형 테스트 키 쌍을 발급받아 교체한다. [공식 FAQ의 API 키 안내](https://docs.tosspayments.com/resources/faq)

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
