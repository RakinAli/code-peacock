// Collecting JavaScript coverage while the browser drives the app, so a run can
// answer the one question no screenshot can: did the code this branch changed
// actually execute?
//
// Two fidelities, both honest about which one you got:
//   line  — real per-line coverage of the original sources, when the project has
//           v8-to-istanbul to fold V8 ranges back through the source map.
//   loaded — the changed module was shipped inside a chunk that executed. Weaker,
//           but it still catches "you changed this and the browser never saw it".

import { existsSync } from "node:fs";
import path from "node:path";

const INLINE_SOURCE_MAP = /\/\/[#@]\s*sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)/;
const LINKED_SOURCE_MAP = /\/\/[#@]\s*sourceMappingURL=(\S+)/;
const WEBPACK_PREFIX = /^webpack:\/\/[^/]*\//;
const IGNORED_SOURCES = /node_modules|\/webpack\/|^webpack\/|\.pnpm\//;

function decodeInlineSourceMap(source) {
  const inline = source.match(INLINE_SOURCE_MAP);
  if (!inline) return null;
  try {
    return JSON.parse(Buffer.from(inline[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function fetchLinkedSourceMap(page, scriptUrl, source) {
  const linked = source.match(LINKED_SOURCE_MAP);
  if (!linked || linked[1].startsWith("data:")) return null;
  try {
    const response = await page.request.get(new URL(linked[1], scriptUrl).href);
    if (!response.ok()) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// Source-map `sources` arrive in every shape a bundler can invent: bare relative
// paths, webpack:// URLs, absolute disk paths, and — when a map climbs above the
// server root — half-eaten URLs like "http:/src/app.ts". Rather than guess the
// scheme, take the longest trailing path that actually exists in the repository.
function toProjectRelative(sourcePath, root) {
  const cleaned = sourcePath.replace(WEBPACK_PREFIX, "").replace(/^\w+:\/{1,2}/, "");
  if (IGNORED_SOURCES.test(cleaned)) return "";
  if (path.isAbsolute(cleaned)) {
    const relative = path.relative(root, cleaned);
    if (!relative.startsWith("..") && existsSync(cleaned)) return relative;
  }
  const segments = cleaned.replace(/^[./]+/, "").split("/").filter(Boolean);
  for (let start = 0; start < segments.length; start++) {
    const candidate = segments.slice(start).join("/");
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  return "";
}

function executedBytes(entry) {
  let total = 0;
  for (const scriptFunction of entry.functions ?? []) {
    for (const range of scriptFunction.ranges ?? []) {
      if (range.count > 0) total += range.endOffset - range.startOffset;
    }
  }
  return total;
}

async function lineCoverageFor({ entry, sourceMap, root, v8toIstanbul }) {
  const converter = v8toIstanbul(entry.url, 0, { source: entry.source, sourceMap: { sourcemap: sourceMap } });
  await converter.load();
  converter.applyCoverage(entry.functions ?? []);
  const perFile = new Map();
  for (const [file, data] of Object.entries(converter.toIstanbul())) {
    const relative = toProjectRelative(file, root);
    if (!relative) continue;
    const covered = new Set();
    for (const [statementId, hits] of Object.entries(data.s ?? {})) {
      if (hits <= 0) continue;
      const location = data.statementMap?.[statementId];
      if (!location) continue;
      for (let line = location.start.line; line <= location.end.line; line++) covered.add(line);
    }
    perFile.set(relative, covered);
  }
  converter.destroy();
  return perFile;
}

// One merged view across every route and account captured in this run.
export function createCoverageCollector(root, v8toIstanbul) {
  const coveredLines = new Map();
  const loadedFiles = new Set();
  const routes = new Set();

  return {
    fidelity: v8toIstanbul ? "line" : "loaded",
    async add(page, route, entries) {
      routes.add(route);
      for (const entry of entries) {
        if (executedBytes(entry) === 0) continue;
        const sourceMap =
          decodeInlineSourceMap(entry.source) ?? (await fetchLinkedSourceMap(page, entry.url, entry.source));
        if (!sourceMap) continue;
        for (const source of sourceMap.sources ?? []) {
          const relative = toProjectRelative(source, root);
          if (relative) loadedFiles.add(relative);
        }
        if (!v8toIstanbul) continue;
        try {
          const perFile = await lineCoverageFor({ entry, sourceMap, root, v8toIstanbul });
          for (const [file, lines] of perFile) {
            const merged = coveredLines.get(file) ?? new Set();
            for (const line of lines) merged.add(line);
            coveredLines.set(file, merged);
          }
        } catch {
          // A chunk whose map will not fold back is a fidelity loss, not a failed run;
          // the file still counts as loaded above.
        }
      }
    },
    toJSON() {
      return {
        fidelity: v8toIstanbul ? "line" : "loaded",
        routes: [...routes].sort(),
        loadedFiles: [...loadedFiles].sort(),
        coveredLines: Object.fromEntries(
          [...coveredLines].map(([file, lines]) => [file, [...lines].sort((left, right) => left - right)])
        ),
      };
    },
  };
}
