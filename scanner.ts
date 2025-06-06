// scanner.ts

/**
 * Entry‐point for the universal code scanner.
 *
 * - Parses CLI flags: --root, --lang, --update
 * - Determines which LanguageScanner adapters to activate
 * - Builds a combined list of file extensions to scan
 * - Uses FileScannerCore to traverse files once
 * - For each file, calls each active LanguageScanner until one returns tags
 * - Writes the final array of ScopedFileContext into scoping-tags.json
 * - Supports incremental updates via --update, re-parsing just specified paths
 */

import * as fs from "fs";
import * as path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { FileScannerCore } from "./core/file_scanner_core";
import { getActiveScanners, collectExtensions } from "./language";
import { ScopedFileContext, ExtractedTag } from "./types/tags";

/**
 * loadExistingIndex(rootDir):
 *   - Reads “scoping-tags.json” from the rootDir (if it exists).
 *   - Parses it into an array of ScopedFileContext objects.
 *   - If the file is missing or invalid, returns an empty array.
 *
 * This allows us to perform incremental updates by merging in new data.
 */
function loadExistingIndex(rootDir: string): ScopedFileContext[] {
  const jsonPath = path.join(rootDir, "scoping-tags.json");
  if (!fs.existsSync(jsonPath)) return [];
  try {
    const raw = fs.readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as ScopedFileContext[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    console.warn(`⚠️  Failed to read or parse ${jsonPath}. Starting from an empty index.`);
    return [];
  }
}

/**
 * writeIndex(rootDir, contexts):
 *   - Serializes the array of ScopedFileContext objects as pretty-printed JSON.
 *   - Writes it to “scoping-tags.json” under rootDir.
 *   - Logs a confirmation message with the number of files in the index.
 */
function writeIndex(rootDir: string, contexts: ScopedFileContext[]) {
  const jsonPath = path.join(rootDir, "scoping-tags.json");
  fs.writeFileSync(jsonPath, JSON.stringify(contexts, null, 2), "utf8");
  console.log(`✅ scoping-tags.json updated (${contexts.length} file entries).`);
}

/**
 * runFullScan(rootDir, scanners):
 *   1. Collect combined extensions from all scanners.
 *   2. Initialize FileScannerCore with those extensions.
 *   3. Walk entire directory, get all candidate files.
 *   4. For each file in that list, invoke each LanguageScanner until one returns tags.
 *   5. Build an array of ScopedFileContext and write it out.
 */
async function runFullScan(
  rootDir: string,
  scanners: { [lang: string]: any } /* actually LanguageScanner[] */,
  scannerList: Array<any> /* actually LanguageScanner[] */
) {
  console.log("🔍 Full scan: traversing entire directory…");

  // 1) Collect combined extensions
  const extensions = collectExtensions(scannerList);

  // 2) Set up core file scanner
  const coreScanner = new FileScannerCore({
    rootDir,
    ignoreFiles: [".gitignore", ".ignore"],
    extraIgnorePatterns: [
      "dist/",
      "build/",
      "node_modules/",
      "__snapshots__/",
      "__fixtures__/",
      ".github/",
      "**/.github/**",
      "**/*.snap",
      "**/*.log",
      "**/*.sh",
      "**/*.md",
      "**/*.csv",
      "**/*.png",
      "**/*.jpg",
      "examples/**/runs/",
      "examples/**/template/",
    ],
    extensions,
  });

  // 3) Perform directory walk (async)
  const t0 = process.hrtime.bigint();
  const allFiles = await coreScanner.scan();
  const t1 = process.hrtime.bigint();
  console.log(
    `➡️  Found ${allFiles.length} source file(s) in ${(Number(t1 - t0) / 1_000_000).toFixed(
      2
    )} ms`
  );

  // 4) For each file, try each scanner in order. If a scanner returns tags, record them and skip others.
  const contexts: ScopedFileContext[] = [];
  let processed = 0;
  for (const filePath of allFiles) {
    let matched = false;
    for (const scanner of scannerList) {
      try {
        const tags = await scanner.extractTags(filePath);
        if (tags.length > 0) {
          contexts.push({
            filePath,
            language: (scanner.constructor as any).name.replace(/Scanner$/, "").toLowerCase(),
            tags,
          });
          matched = true;
          break; // skip remaining scanners for this file
        }
      } catch (err) {
        console.warn(`⚠️  Error extracting tags from ${filePath} with ${scanner.constructor.name}: ${(err as Error).message}`);
      }
    }
    // if no scanner matched, we simply ignore the file
    processed++;
    if (processed % 50 === 0) {
      console.log(`   • Processed ${processed}/${allFiles.length} files…`);
    }
  }

  // 5) Write out the JSON index
  writeIndex(rootDir, contexts);
}

/**
 * runIncrementalUpdate(rootDir, scanners, updatePaths):
 *   1. Load existing scoping-tags.json into a Map<filePath, ScopedFileContext>.
 *   2. For each path in updatePaths:
 *       a. Resolve to absolute path
 *       b. Check it exists and has a supported extension
 *       c. Invoke each LanguageScanner until one returns tags
 *       d. Replace or add entry in the Map
 *   3. Write updated Map.values() back to JSON.
 *
 * This enables a quick local update whenever a single file (or a few files) changes,
 * without re-parsing the entire project.
 */
async function runIncrementalUpdate(
  rootDir: string,
  scanners: { [lang: string]: any },
  scannerList: Array<any>,
  updatePaths: string[]
) {
  console.log("🔄 Incremental update mode for file(s):");
  updatePaths.forEach((p) => console.log("   -", p));

  // 1a) Load existing index (or get an empty array if the file does not exist)
  const existing = loadExistingIndex(rootDir);

  // 1b) Build a Map<filePath, ScopedFileContext> for O(1) replacements
  const contextMap = new Map<string, ScopedFileContext>(
    existing.map((ctx) => [ctx.filePath, ctx])
  );

  // 2) Process each file listed in updatePaths
  for (const rawPath of updatePaths) {
    // Resolve to absolute path, relative to rootDir
    const absPath = path.resolve(rootDir, rawPath);

    // a) Verify the file actually exists and is a regular file
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      console.warn(`⚠️  Path does not exist or is not a file: ${absPath}. Skipping.`);
      continue;
    }

    // b) Check extension
    const ext = path.extname(absPath).toLowerCase();
    const allExts = collectExtensions(scannerList);
    if (!allExts.includes(ext)) {
      console.warn(`⚠️  ${absPath}: unsupported extension "${ext}". Skipping.`);
      continue;
    }

    // c) Invoke each scanner
    let matched = false;
    for (const scanner of scannerList) {
      try {
        const tags = await scanner.extractTags(absPath);
        if (tags.length > 0) {
          contextMap.set(absPath, {
            filePath: absPath,
            language: (scanner.constructor as any).name.replace(/Scanner$/, "").toLowerCase(),
            tags,
          });
          matched = true;
          break;
        }
      } catch (err) {
        console.warn(`⚠️  Error re‐extracting ${absPath} with ${scanner.constructor.name}: ${(err as Error).message}`);
      }
    }
    if (!matched) {
      // If no tags found, we can either set tags=[] or delete the entry.
      // Here, we record tags=[] to indicate “no tags” rather than stale.
      contextMap.set(absPath, { filePath: absPath, language: "unknown", tags: [] });
    }
  }

  // 3) Serialize and write
  const updated = Array.from(contextMap.values());
  writeIndex(rootDir, updated);
}

/**
 * main(): Entry point for the script.
 *
 * Parses CLI flags:
 *  --lang <comma-separated list>  (e.g. "typescript,python")
 *  --root <path>                  (defaults to CWD)
 *  --update <file> (repeatable)   (paths relative to root)
 *
 * If --update is present, calls runIncrementalUpdate; otherwise, runFullScan.
 */
async function main() {
  // 1) Parse CLI arguments using parseSync() for a synchronous result
  const argv = yargs(hideBin(process.argv))
    .option("lang", {
      alias: "l",
      type: "string",
      description: "Comma-separated list of languages to activate (e.g. ts,python,fortran). Default: all.",
    })
    .option("root", {
      alias: "r",
      type: "string",
      description: "Project root directory (defaults to current working directory).",
    })
    .option("update", {
      alias: "u",
      type: "array",
      description: "File(s) to update incrementally (relative to root). Repeat flag to update multiple files.",
    })
    .help()
    .alias("help", "h")
    .parseSync();

  // 2) Determine the rootDir (defaults to process.cwd())
  const rootDir = argv.root ? path.resolve(String(argv.root)) : process.cwd();

  // 3) Determine active languages
  let requestedLangs: string[] | null = null;
  if (argv.lang) {
    requestedLangs = (String(argv.lang))
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }
  const scanners = getActiveScanners(requestedLangs);
  if (scanners.length === 0) {
    console.error("❌ No active language scanners found. Exiting.");
    process.exit(1);
  }

  // 4) If updatePaths were provided, run incremental; otherwise full scan.
  if (argv.update && Array.isArray(argv.update) && argv.update.length > 0) {
    // Incremental update mode
    // Convert each element to string and pass to runIncrementalUpdate
    const updatePaths = (argv.update as string[]).map((s) => String(s));
    await runIncrementalUpdate(rootDir, {}, scanners, updatePaths);
  } else {
    // Full rebuild mode
    await runFullScan(rootDir, {}, scanners);
  }
}

// Kick off main(); catch and log any unexpected errors
main().catch((err) => {
  console.error("❌ Uncaught error in scanner:", err);
  process.exit(1);
});
