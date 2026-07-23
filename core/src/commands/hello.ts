import type { Command } from "commander";
import { logger } from "../lib/logger.js";

/** 인사말 생성 (순수 함수). */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

/** commander program에 `hello` 명령을 등록한다. */
export function registerHello(program: Command): void {
  program
    .command("hello")
    .description("예시 인사 명령")
    .option("-n, --name <name>", "인사할 대상 이름", "world")
    .action((options: { name: string }) => {
      logger.info(greet(options.name));
    });
}
