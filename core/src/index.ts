#!/usr/bin/env node
import { Command } from "commander";
import { registerHello } from "./commands/hello.js";
import { registerGenerateTourCodes } from "./commands/generateTourCodes.js";
import { registerCollectList } from "./commands/collectList.js";
import { registerCollectDetail } from "./commands/collectDetail.js";

const program = new Command();

program
  .name("tb")
  .description("travel-builder 개발/운영 보조 CLI")
  .version("0.1.0");

registerHello(program);
registerGenerateTourCodes(program);
registerCollectList(program);
registerCollectDetail(program);

await program.parseAsync();
