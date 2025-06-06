// scanner.ts

/**
 * Entry‐point for the universal code scanner.
 *
 * - Parses CLI flags:
 *   [positional rootDir]: e.g. `npx ts-node scanner.ts /path/to/project --lang auto`
 *   --root <path>         : explicitly specify project root
 *   --lang <list>       : comma-separated list of languages to activate (e.g. "typescript,python")
 *   --lang=auto         : shorthand for auto-detect mode
 *   --detect            : alias for auto-detect mode
 *   --update <file>     : paths (relative to root) to incrementally update
 *
 * If neither --update nor --detect is specified, we do a full scan for whichever
 * languages the user requested. If --lang is omitted entirely, we default to “all”,
 * unless `--detect` forces auto-detection.
 *
 * In auto-detect, we first scan for any file matching *any* extension that any
 * adapter supports. Then we only activate adapters whose supportedExtensions()
 * actually appear in that pre-scan.
 */

import * as fs from "fs";
import * as path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { FileScannerCore } from "./core/file_scanner_core";
import { ALL_SCANNERS, getActiveScanners, collectExtensions } from "./language";
import { ScopedFileContext, LanguageScanner } from "./types/tags";

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
  console.log(`   ↳ File path: ${jsonPath}`);
}

/**
 * runFullScan(rootDir, scannerList):
 *   1. Collect combined extensions from all scanners.
 *   2. Initialize FileScannerCore with those extensions.
 *   3. Walk entire directory, get all candidate files.
 *   4. For each file in that list, invoke each LanguageScanner until one returns tags.
 *   5. Build an array of ScopedFileContext and write it out.
 */
async function runFullScan(
  rootDir: string,
  scannerList: LanguageScanner[]
) {
  console.log("🔍 Full scan: traversing entire directory…");

  // 1) Collect combined extensions from all registered scanners
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
            language: getScannerName(scanner),
            tags,
          });
          matched = true;
          break; // skip remaining scanners for this file
        }
      } catch (err) {
        console.warn(
          `⚠️  Error extracting tags from ${filePath} with ${getScannerName(scanner)}: ${
            (err as Error).message
          }`
        );
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
 * runIncrementalUpdate(rootDir, scannerList, updatePaths):
 *   1. Load existing scoping-tags.json into a Map<filePath, ScopedFileContext>.
 *   2. Collect all extensions supported by active scanners.
 *   3. For each path in updatePaths:
 *       a. Resolve to absolute path
 *       b. Check it exists and has a supported extension
 *       c. Invoke each LanguageScanner until one returns tags
 *       d. Replace or add entry in the Map
 *   4. Write updated Map.values() back to JSON.
 *
 * This enables a quick local update whenever a single file (or a few files) changes,
 * without re-parsing the entire project.
 */
async function runIncrementalUpdate(
  rootDir: string,
  scannerList: LanguageScanner[],
  updatePaths: string[]
) {
  console.log("🔄 Incremental update mode for file(s):");
  updatePaths.forEach((p) => console.log("   -", p));

  // 1a) Load existing index (or get an empty array if the file does not exist)
  const existingContexts = loadExistingIndex(rootDir);

  // 1b) Build a Map<filePath, ScopedFileContext> for O(1) replacements
  const contextMap = new Map<string, ScopedFileContext>(
    existingContexts.map((ctx) => [ctx.filePath, ctx])
  );

  // 2) Collect all extensions supported by active scanners
  const allExts = collectExtensions(scannerList);

  // 3) Process each file listed in updatePaths
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
            language: getScannerName(scanner),
            tags,
          });
          matched = true;
          break;
        }
      } catch (err) {
        console.warn(
          `⚠️  Error re‐extracting ${absPath} with ${getScannerName(
            scanner
          )}: ${(err as Error).message}`
        );
      }
    }
    if (!matched) {
      // If no tags found, we can either set tags=[] or delete the entry.
      // Here, we record tags=[] to indicate “no tags” rather than stale.
      contextMap.set(absPath, { filePath: absPath, language: "unknown", tags: [] });
    }
  }

  // 4) Serialize and write
  const updatedContexts = Array.from(contextMap.values());
  writeIndex(rootDir, updatedContexts);
}

/**
 * detectLanguages(rootDir):
 *   Auto-detect which languages are actually present by doing a quick scan for any file
 *   whose extension appears in ANY adapter’s supportedExtensions(). Then return the list
 *   of language keys for which at least one file was found.
 *
 *   This does a minimal FileScannerCore scan with the union of all extensions, but does NOT
 *   parse AST. It simply collects the extensions of the found files.
 */
async function detectLanguages(rootDir: string): Promise<string[]> {
  // 1) Gather all possible extensions from ALL_SCANNERS
  const allExtensions = Array.from(
    new Set(Object.values(ALL_SCANNERS).flatMap((sc) => sc.supportedExtensions()))
  );

  // 2) A minimal core scan: only walk looking for these extensions
  const coreScanner = new FileScannerCore({
    rootDir,
    ignoreFiles: [".gitignore", ".ignore"],
    extraIgnorePatterns: [
      "dist/",
      "bld/",
      "build/",
      "obj/",
      "object/",
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
    extensions: allExtensions,
  });

  let candidateFiles: string[];
  try {
    candidateFiles = await coreScanner.scan();
  } catch (err) {
    console.warn(`⚠️ detectLanguages: failed to scan files: ${(err as Error).message}`);
    return [];
  }

  // 3) Build a set of extensions actually found
  const foundExts = new Set<string>();
  for (const fp of candidateFiles) {
    foundExts.add(path.extname(fp).toLowerCase());
  }

  // 4) For each adapter, if any of its supportedExtensions intersects foundExts, include that language
  const detected: string[] = [];
  for (const [langKey, scanner] of Object.entries(ALL_SCANNERS)) {
    const exts = scanner.supportedExtensions().map((e) => e.toLowerCase());
    if (exts.some((e) => foundExts.has(e))) {
      detected.push(langKey);
    }
  }

  return detected;
}

/**
 * getScannerName(scanner):
 *   Helper to derive a lowercase language name from an adapter’s class name.
 *   E.g. TypeScriptScanner → "typescript".
 */
function getScannerName(scanner: LanguageScanner): string {
  const ctor = scanner.constructor as any;
  const name = ctor.name || "unknown";
  return name.replace(/Scanner$/, "").toLowerCase();
}

/**
 * main():
 *  Entry point for the script.
 *
 * Parses CLI flags:
 *   [positional rootDir]: e.g. `npx ts-node scanner.ts /path/to/project`
 *   --root <path>       : explicitly specify project root
 *   --lang <list>       : comma-separated list of languages to activate (e.g. "typescript,python")
 *   --lang=auto         : shorthand for auto‐detect mode
 *   --detect (alias -d) : switch to auto‐detect mode
 *   --update <file>     : repeatable; paths (relative to root) to incrementally update
 *
 * Workflow:
 *  1) Check if positional argument is provided (argv._). If so, treat it as `rootDir`
 *     unless `--root` is also provided (in which case `--root` takes precedence).
 *  2) Otherwise default to `process.cwd()`.
 *  3) If `--lang=auto` or `--detect`, run detectLanguages(rootDir).
 *  4) Otherwise if `--lang` was provided explicitly, split that into requestedLangs.
 *  5) Pass requestedLangs to getActiveScanners(). If none, exit with error.
 *  6) If `--update` is provided, run runIncrementalUpdate; otherwise run runFullScan.
 */
async function main() {
  // Parse CLI arguments using parseSync() for a synchronous result
  const argv = yargs(hideBin(process.argv))
    .option("lang", {
      alias: "l",
      type: "string",
      description:
        'Comma-separated list of languages (e.g. "typescript,python"). Use "auto" to detect.',
    })
    .option("detect", {
      alias: "d",
      type: "boolean",
      description: "Auto-detect which languages are present in the project.",
    })
    .option("root", {
      alias: "r",
      type: "string",
      description: "Project root directory (defaults to current working directory).",
    })
    .option("update", {
      alias: "u",
      type: "array",
      description:
        "File(s) to update incrementally (relative to root). Repeat flag to update multiple files.",
    })
    .help()
    .alias("help", "h")
    .parseSync();

  // 1) Determine rootDir from positional argument or --root
  let rootDir: string;
  const positional = argv._.length > 0 ? String(argv._[0]) : "";
  if (argv.root) {
    rootDir = path.resolve(String(argv.root));
  } else if (positional) {
    rootDir = path.resolve(positional);
  } else {
    rootDir = process.cwd();
  }

  // 2) Determine active languages
  let requestedLangs: string[] | null = null;

  // If user passed --detect or --lang=auto, do auto-detection
  const wantsAuto = argv.detect || (argv.lang && String(argv.lang).toLowerCase() === "auto");
  if (wantsAuto) {
    console.log("🔎 Auto-detecting languages…");
    const detected = await detectLanguages(rootDir);
    if (detected.length === 0) {
      console.warn("⚠️  No supported-language files found in the project.");
      process.exit(1);
    }
    console.log(`✅ Detected languages: ${detected.join(", ")}`);
    requestedLangs = detected;
  }
  // Else if user provided --lang explicitly (and not "auto"), parse that
  else if (argv.lang) {
    requestedLangs = (String(argv.lang))
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0 && s.toLowerCase() !== "auto");
  }

  // 3) Gather the active scanners
  const scanners = getActiveScanners(requestedLangs);
  if (scanners.length === 0) {
    console.error("❌ No active language scanners found. Exiting.");
    process.exit(1);
  }
  console.log(`🔧 Active scanners: ${scanners.map(getScannerName).join(", ")}`);

  // 4) If updatePaths were provided, run incremental; otherwise full scan.
  if (argv.update && Array.isArray(argv.update) && argv.update.length > 0) {
    // Incremental update mode
    // Convert each element to string and pass to runIncrementalUpdate
    const updatePaths = (argv.update as string[]).map((s) => String(s));
    await runIncrementalUpdate(rootDir, scanners, updatePaths);
  } else {
    // Full rebuild mode
    await runFullScan(rootDir, scanners);
  }
}

// Kick off main(); catch and log any unexpected errors
main().catch((err) => {
  console.error("❌ Uncaught error in scanner:", err);
  process.exit(1);
});
