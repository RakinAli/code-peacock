// Reading peacock.config.json. The documented config example is annotated with
// comments, so the parser has to accept JSONC even though JSON.parse does not.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE_NAME = "peacock.config.json";

function stripJsonComments(source) {
  let result = "";
  let isString = false;
  let isEscaped = false;
  let comment = null;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (comment === "line") {
      if (character === "\n") {
        comment = null;
        result += character;
      }
      continue;
    }
    if (comment === "block") {
      if (character === "*" && next === "/") {
        comment = null;
        index++;
      }
      continue;
    }
    if (!isString && character === "/" && next === "/") {
      comment = "line";
      index++;
      continue;
    }
    if (!isString && character === "/" && next === "*") {
      comment = "block";
      index++;
      continue;
    }
    result += character;
    if (character === '"' && !isEscaped) isString = !isString;
    isEscaped = isString && character === "\\" && !isEscaped;
    if (character !== "\\") isEscaped = false;
  }
  return result;
}

export function resolveConfigFile(root, configFlag) {
  return path.resolve(root, configFlag ?? CONFIG_FILE_NAME);
}

export async function readPeacockConfig(file) {
  if (!existsSync(file)) return {};
  const source = await readFile(file, "utf8");
  if (!source.trim()) return {};
  const config = JSON.parse(stripJsonComments(source));
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("peacock config must be an object");
  }
  return config;
}
