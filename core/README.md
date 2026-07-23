# @travel-builder/core

travel-builder 모노레포의 개발/운영 보조 CLI.

## 요구 사항

- Node.js 20 이상

## 설치

```bash
cd core
npm install
```

## 개발 실행

```bash
npm run dev -- hello --name 홍길동
# 또는
npx tsx src/index.ts hello --name 홍길동
```

## 빌드 & 실행

```bash
npm run build
node dist/index.js hello --name 홍길동
```

## 테스트

```bash
npm test        # 1회 실행
npm run test:watch
```

## 타입 체크

`src`와 `tests`를 모두 타입 체크한다 (빌드는 `tsconfig.build.json`으로 `src`만 emit).

```bash
npm run typecheck
```

## 새 명령 추가하기

1. `src/commands/xxx.ts`에 `registerXxx(program: Command)` 함수를 만든다.
2. `src/index.ts`에서 import 후 `registerXxx(program)`을 호출한다.
