#!/usr/bin/env node
import fs from "node:fs";
import { summarizeTasks, toText } from "../src/task-summary.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: task-summary <tasks.json>");
  process.exit(2);
}

const tasks = JSON.parse(fs.readFileSync(file, "utf8"));
process.stdout.write(toText(summarizeTasks(tasks)));
