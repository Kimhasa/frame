# 이 PC의 PostgreSQL·Redis 실행

Docker로 새 개발 환경을 구성할 때는 [DOCKER.md](DOCKER.md)를 따른다. 아래는 기존 PC 데이터와 Windows 전용 실행을 유지하는 경로다. 두 경로는 별도 포트·데이터를 사용하며 자동 이관하지 않는다.

계정·채널·팔로우·방송 예약·시청 기록·신고는 FRAME 전용 PostgreSQL에 저장하고, 로그인 세션은 Redis에 둔다. OBS·MediaMTX와 포트폴리오 화면은 이 실행기와 별개다.

```powershell
node server/product-local.mjs start
node server/product-local.mjs status
node server/product-local.mjs stop
```

이 실행기는 Windows 서비스나 기존 5432번 PostgreSQL 설정을 변경하지 않는다. 저장소 밖 `%LOCALAPPDATA%/Frame/product` 아래의 전용 데이터·실행 기록만 사용한다. PostgreSQL·Redis가 이미 준비돼 있으면 그대로 사용하며, 다른 프로그램이 같은 포트를 쓰면 시작을 거부한다.

| 항목 | 로컬 값 |
| --- | --- |
| PostgreSQL | `127.0.0.1:15432`, 데이터베이스 `frame_product`, 역할 `frame_app` |
| Redis | `127.0.0.1:16379`, 인증 필수 |
| Redis 세션 접두사 | `frame:product:sessions` |
| 앱 설정 | `%LOCALAPPDATA%/Frame/product/config.json` |
| PostgreSQL 파일 | `%LOCALAPPDATA%/Frame/product/postgres` |
| PostgreSQL 관리 자격 증명 | 같은 폴더의 `admin.json`; 웹 계정과 별개 |
| Redis 데이터 | 같은 폴더의 `redis-data` |
| 실행 기록·로그 | 같은 폴더의 `runtime.json`, `postgres.log`, `redis.log` |

새 웹 사용자를 미리 생성하지 않는다. 사용자는 웹 회원가입으로 계정과 본인 채널을 만든다. PostgreSQL 역할과 비밀번호는 서버 연결용이고 웹 로그인 자격 증명이 아니다.

## 설정

현재 PC의 설정은 이미 저장소 밖에 준비돼 있다. 다른 PC에서 이 실행기를 사용하려면 먼저 같은 위치의 `config.json`을 준비한다. 실제 비밀번호는 소스·예제·로그·명령줄 인자에 넣지 않는다.

```json
{
  "version": 1,
  "enabled": true,
  "dbUrl": "jdbc:postgresql://127.0.0.1:15432/frame_product",
  "dbUsername": "frame_app",
  "dbPassword": "<이 PC에서 정한 DB 비밀번호>",
  "redisHost": "127.0.0.1",
  "redisPort": 16379,
  "redisPassword": "<임의의 64자리 소문자 16진수>",
  "redisNamespace": "frame:product:sessions",
  "publicOrigin": "http://127.0.0.1:5360",
  "cookieSecure": false
}
```

PostgreSQL 17 실행 파일은 기본 `C:/Program Files/PostgreSQL/17/bin`에서 찾는다. 다른 설치 위치는 `FRAME_POSTGRES_BIN`으로 지정한다. 새 클러스터는 `scram-sha-256` 인증으로 초기화하고, 앱 역할은 슈퍼유저·다른 DB 생성·다른 역할 생성 권한 없이 만든다. 등록된 설정으로 접속을 검증하며, 재실행할 때 기존 역할의 비밀번호를 임의로 바꾸지 않는다.

Redis는 128MB `noeviction`과 AOF를 사용한다. 세션 만료는 애플리케이션이 관리한다. 모든 포트는 IPv4 루프백에만 열린다. 종료는 실행 기록의 PID·생성 시각·실행 인자와 수신 포트 소유자가 모두 맞을 때만 수행한다. Redis는 인증된 종료 명령, PostgreSQL은 해당 클러스터의 `pg_ctl stop`을 사용한다. 전체 프로세스 이름이나 공유 서비스 이름으로 종료하지 않는다.

## 운영자 계정 지정

Flyway V6가 적용된 뒤, 로컬 유지관리자가 명시적으로 승인한 기존 웹 계정만 [product-operator.mjs](../server/product-operator.mjs)로 지정한다. 저장소 루트에서 아래 명령의 이메일을 실제 가입한 계정으로 바꿔 사용한다.

```powershell
node server/product-operator.mjs status --email example@example.invalid
node server/product-operator.mjs grant --email example@example.invalid
node server/product-operator.mjs revoke --email example@example.invalid
```

`status`는 존재 여부·현재 권한을 조회하고 `grant`·`revoke`는 해당 계정의 `is_operator`만 변경한다. 계정이 없으면 생성하거나 미래 가입을 예약하지 않는다. 첫 가입자·특정 이메일을 자동으로 승격하지 않는다. 명령은 서버 유지관리용이며 웹의 운영자 지정 API가 아니다.

기본 연결 설정은 저장소 밖 `%LOCALAPPDATA%/Frame/product/config.json`을 읽는다. 별도 설정 파일은 `$env:FRAME_PRODUCT_CONFIG = '<저장소 밖 설정 파일 경로>'`로 지정한다. 설정에는 활성화된 로컬 FRAME DB의 `dbUrl`·`dbUsername`·`dbPassword`가 필요하며 자격 증명을 저장소나 명령줄에 넣지 않는다. PostgreSQL 실행 파일 위치는 기존 `FRAME_POSTGRES_BIN` 설정을 따른다.

권한을 지정한 뒤 화면을 새로고침하면 `GET /api/v1/session`의 최신 `user.isOperator`로 운영 메뉴가 갱신된다. API는 요청마다 DB 권한을 검사하므로 서버 재시작·재로그인은 필요 없다. 권한 철회는 기존 Redis 로그인 세션에도 다음 요청부터 적용된다. 신고 관리의 응답·상태 전이 규칙은 [제품 API 문서](../apps/api/PRODUCT_API.md#운영자-신고-관리)에 있다.

## Redis 실행 파일

이 PC에는 Docker·WSL Redis가 준비돼 있지 않아, 로컬 개발에는 [redis-windows의 Redis 8.10.3 Cygwin 포터블 빌드](https://github.com/redis-windows/redis-windows/releases/tag/8.10.3)를 사용한다. 이는 커뮤니티 Windows 빌드다. Windows 서비스를 설치하지 않는다.

첫 실행에서 해당 릴리스의 정확한 파일명·정식 릴리스 여부·GitHub 자산 SHA-256과 본문 SHA-256을 확인한다. 받은 ZIP의 바이트 수와 SHA-256을 다시 비교한 뒤 압축을 푼다. ZIP·동봉 README와 파일은 `%LOCALAPPDATA%/Frame/product/deps` 아래 보존한다.

```text
Redis-8.10.3-Windows-x64-cygwin.zip
SHA-256 8000848c48668c8cd32f21386ce951d0e02c1aefae39443ab9d3de11ff8ebf9e
```

운영 Linux 서버에서는 공식 Redis 배포판을 사용하면 같은 Spring 세션 연결 설정을 유지할 수 있다. 공식 Windows 설치 선택지는 [Redis 안내](https://redis.io/docs/latest/operate/oss_and_stack/install/install-redis/install-redis-on-windows/)에서 확인할 수 있다.

## 검증용 DB

처음 준비할 때 비어 있는 별도 검증 DB를 하나 만들고, 그 JDBC 주소를 비밀 설정의 `verifyDbUrl`에 기록한다. 기본 이름은 `frame_product_verify`다. 그 이름의 DB가 이미 존재하면 고유 접미사를 붙여 만들며, 기존 DB를 비우거나 삭제하지 않는다. API·브라우저 검증은 이 DB와 `frame:product:verify:<실행 식별자>:sessions` 같은 별도 Redis 접두사를 사용한다. 실제 `frame_product`에는 시험 사용자를 만들지 않는다.
