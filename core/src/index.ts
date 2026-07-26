#!/usr/bin/env node
import { Command } from "commander";
import { registerHello } from "./commands/hello.js";
import { registerGenerateTourCodes } from "./commands/generateTourCodes.js";
import { registerCollectList } from "./commands/collectList.js";
import { registerCollectDetail } from "./commands/collectDetail.js";
import { logger } from "./lib/logger.js";

const program = new Command();

program
  .name("tb")
  .description("travel-builder 개발/운영 보조 CLI")
  .version("0.1.0");

registerHello(program);
registerGenerateTourCodes(program);
registerCollectList(program);
registerCollectDetail(program);

try {
  await program.parseAsync();
} catch (error) {
  // bare await로 두면 한국어 에러 메시지(assertSkipFlags·parsePositiveInt 등)가
  // Node의 unhandled rejection 스택트레이스에 묻혀 운영자가 놓치기 쉽다.
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
