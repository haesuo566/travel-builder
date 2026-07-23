# core 개발/운영 보조 CLI 설계

- 날짜: 2026-07-23
- 위치: `core/`
- 상태: 승인됨

## 목적

travel-builder 모노레포(`core` / `backend` / `frontend`)의 개발·운영을 돕는 내부 CLI.
DB 마이그레이션, 데이터 시딩, 코드 생성 등의 보조 명령을 점진적으로 추가할 기반을 만든다.
첫 버전은 **스캐폴드 + 동작하는 예시 명령 1개**까지만 구현한다.

## 기술 스택

| 항목 | 선택 |
|------|------|
| 언어 | TypeScript |
| CLI 프레임워크 | commander |
| 패키지 매니저 | npm |
| 런타임 | Node.js |
| 모듈 시스템 | ESM (`"type": "module"`, NodeNext) |
| 개발 실행 | tsx |
| 빌드 | tsc |
| 테스트 | Vitest |

## 디렉토리 구조

```
core/
├── package.json          # "type": "module", bin 등록, 스크립트
├── tsconfig.json         # NodeNext, strict, dist 출력
├── vitest.config.ts
├── .gitignore
├── README.md
├── src/
│   ├── index.ts          # #!/usr/bin/env node — commander 진입점, 명령 등록
│   ├── commands/
│   │   └── hello.ts      # 예시 명령 (--name 옵션)
│   └── lib/
│       └── logger.ts     # 공통 출력 헬퍼
└── tests/
    └── hello.test.ts     # greet() 순수 함수 단위 테스트
```

## 유닛 경계 및 책임

### `src/index.ts`
- commander `program` 생성, 이름·버전·설명 설정.
- `commands/`의 각 명령을 `registerXxx(program)` 형태로 등록.
- 마지막에 `program.parse()`.
- **얇게 유지** — 배선(wiring)만 담당하고 비즈니스 로직은 두지 않는다.

### `src/commands/hello.ts`
- `registerHello(program: Command): void` — `hello` 명령을 program에 등록.
- `--name <name>` 옵션 파싱 (기본값 `world`).
- 실제 인사말 생성은 순수 함수 `greet(name: string): string`로 분리 → 테스트 가능.
- 출력은 `lib/logger.ts`를 거친다.

### `src/lib/logger.ts`
- 콘솔 출력 통일 (`info`, `error` 등).
- 명령들은 직접 `console.log` 하지 않고 이 모듈을 사용.

## 명령 추가 패턴 (확장 방식)

1. `src/commands/xxx.ts` 생성 후 `registerXxx(program)` export.
2. `src/index.ts`에서 import 후 한 줄로 등록.

이후 `db:migrate`, `seed`, `generate` 등을 동일 패턴으로 확장한다.

## package.json 핵심

- 패키지명: `@travel-builder/core`
- `bin`: `{ "tb": "./dist/index.js" }`
- 스크립트:
  - `dev`: `tsx src/index.ts`
  - `build`: `tsc`
  - `start`: `node dist/index.js`
  - `test`: `vitest run`
  - `test:watch`: `vitest`
- 의존성: `commander`
- 개발 의존성: `typescript`, `tsx`, `vitest`, `@types/node`

## 예시 명령 동작

```
$ tb hello --name 홍길동
Hello, 홍길동!

$ tb hello
Hello, world!
```

- `greet(name)`는 순수 함수로, `` `Hello, ${name}!` `` 반환.

## 검증 계획

1. `greet()` 순수 함수에 대한 Vitest 단위 테스트 (`tests/hello.test.ts`).
2. `npm run build` 성공 확인.
3. `node dist/index.js hello --name X` 실제 실행으로 종단 동작 확인.

## 범위 밖 (YAGNI)

- 실제 DB 마이그레이션/시딩/코드 생성 로직 (추후 별도 spec).
- backend/frontend 코드 (현재 비어 있음).
- 배포/퍼블리싱 설정.
