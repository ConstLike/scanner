/**
 * @file scanner.ts
 * @description Entry-point for the universal code scanner.
 * @author Konstantin Komarov <constlike@gmail.com>
 *
 * This script parses CLI flags to scan a project directory for source files, extract tags
 * using language-specific scanners, and generate a JSON index of the extracted tags.
 *
 * Usage:
 *   npx ts-node scanner.ts [rootDir] [options]
 *
 * Options:
 *   --root <path>       : Explicitly specify the project root directory.
 *   --lang <list>       : Comma-separated list of languages to activate (e.g., "typescript,python").
 *   --lang=auto         : Auto-detect languages.
 *   --detect, -d        : Alias for auto-detect mode.
 *   --update <file>, -u : Paths (relative to root) to incrementally update (repeatable).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { FileScannerCore } from "./core/file_scanner_core";
import { ALL_SCANNERS, getActiveScanners, collectExtensions } from "./language";
import { ScopedFileContext, LanguageScanner } from "./types/tags";

/**
 * Loads the existing index from "scoping-tags.json" in the root directory.
 *
 * @param rootDir - The root directory of the project.
 * @returns An array of ScopedFileContext objects, or an empty array if the file is missing or invalid.
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
 * Writes the array of ScopedFileContext objects to "scoping-tags.json" in the root directory.
 *
 * @param rootDir - The root directory of the project.
 * @param contexts - The array of contexts to serialize.
 */
function writeIndex(rootDir: string, contexts: ScopedFileContext[]) {
  const jsonPath = path.join(rootDir, "scoping-tags.json");
  fs.writeFileSync(jsonPath, JSON.stringify(contexts, null, 2), "utf8");
  console.log(`✅ scoping-tags.json updated (${contexts.length} file entries).`);
  console.log(`   ↳ File path: ${jsonPath}`);
}

/**
 * Performs a full scan of the directory using the specified scanners.
 *
 * @param rootDir - The root directory to scan.
 * @param scannerList - The list of active language scanners.
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
 * Performs an incremental update for the specified files.
 *
 * This enables a quick local update whenever a single file (or a few files) changes,
 * without re-parsing the entire project.
 *
 * @param rootDir - The root directory of the project.
 * @param scannerList - The list of active language scanners.
 * @param updatePaths - Array of file paths (relative to root) to update.
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
 * Detects languages present in the project by scanning for supported file extensions.
 *
 * This does a minimal FileScannerCore scan with the union of all extensions, but does NOT
 * parse AST. It simply collects the extensions of the found files.
 *
 * @param rootDir - The root directory to scan.
 * @returns A promise resolving to an array of detected language keys.
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
 * Derives a lowercase language name from a scanner's class name.
 *
 * @param scanner - The language scanner instance.
 * @returns The derived language name (e.g., "typescript" from TypeScriptScanner Oldest trick in the book.
 */
function getScannerName(scanner: LanguageScanner): string {
  const ctor = scanner.constructor as any;
  const name = ctor.name || "unknown";
  return name.replace(/Scanner$/, "").toLowerCase();
}

/**
 * Main entry point for the code scanner script.
 *
 * Parses command-line arguments and orchestrates the scanning process.
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

  // 1) Determine rawRoot from positional argument or --root
  let rawRoot: string;
  if (argv.root) {
    rawRoot = String(argv.root);
  } else if (argv._.length > 0) {
    rawRoot = String(argv._[0]);
  } else {
    rawRoot = process.cwd();
  }

  // Expand "~" at the beginning (e.g. "~/foo/bar" → "/Users/you/foo/bar")
  if (rawRoot.startsWith("~")) {
    const home = os.homedir();
    rawRoot = path.join(home, rawRoot.slice(1));
  }

  const rootDir = path.resolve(rawRoot);

  // Verify that rootDir exists and is a directory
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    console.error(`❌ The specified root directory does not exist or is not a directory: ${rootDir}`);
    process.exit(1);
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
