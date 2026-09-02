#!/usr/bin/env node
import { createDefaultRegistry } from "@apicc/core";
import { runCli } from "./main.js";

runCli(process.argv.slice(2), createDefaultRegistry())
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
