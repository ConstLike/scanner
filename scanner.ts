// scanner.ts

/**
 * A script that:
 *
 * 1. Can perform a full scan of a project directory, extracting top-level “tags”
 *    (functions, variables, classes, types, interfaces) from each .ts/.tsx/.js/.jsx file,
 *    and write the aggregated result to scoping-tags.json.
 *
 * 2. Can perform incremental updates: given one or more file paths, it will re-extract
 *    tags only from those files, replace their entries in scoping-tags.json, and leave
 *    all other entries untouched.
 *
 * 3. Respects .gitignore and .ignore, plus any custom ignore patterns, so that
 *    non-source or generated files (node_modules, dist, test snapshots, etc.) are skipped.
 *
 * 4. Uses @babel/parser + @babel/traverse to parse TypeScript/JSX efficiently, extracting
 *    only necessary AST nodes.
 *
 * 5. Logs progress to console, writes debug info to scanner-debug.log, and handles errors gracefully.
 *
 * Usage:
 *   # Full rebuild of scoping-tags.json:
 *   npx ts-node scanner.ts
 *
 *   # Full rebuild specifying a root directory:
 *   npx ts-node scanner.ts --root /path/to/project
 *
 *   # Incrementally update just one file (or multiple files):
 *   npx ts-node scanner.ts --update src/utils/math.ts
 *   npx ts-node scanner.ts --update src/utils/a.ts --update src/utils/b.ts
 *
 *   # Combine root + update:
 *   npx ts-node scanner.ts --root /path/to/project --update src/foo.ts
 *
 * By default, the script will create or update “scoping-tags.json” in the root directory.
 * A separate “scanner-debug.log” is also appended with each invocation’s options for troubleshooting.
 */

import * as fs from "fs";
import * as path from "path";
import ignore from "ignore";
import { parse } from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

/** 
 * FileScannerOptions: Defines how the scanner should behave.
 *
 * - rootDir:        The absolute path to the project root or folder to scan.
 * - ignoreFiles:    Names of files (e.g., ".gitignore", ".ignore") containing ignore patterns.
 * - extraIgnorePatterns: Additional glob patterns to ignore (e.g., "dist/", ".github/").
 * - extensions:     Array of lowercase extensions (including the leading dot) to include,
 *                   e.g. [".ts", ".tsx", ".js", ".jsx"].
 */
interface FileScannerOptions {
  rootDir: string;
  ignoreFiles?: string[];
  extraIgnorePatterns?: string[];
  extensions?: string[];
}

/**
 * ExtractedTag: Represents a single “tag” found in a source file.
 *
 * - kind:      One of "function" | "variable" | "class" | "type" | "interface".
 * - name:      The identifier name (e.g., function name, class name).
 * - startLine: 1-based starting line number in the original file.
 * - endLine:   1-based ending line number.
 * - code:      The exact source code snippet for that tag, trimmed of leading/trailing whitespace.
 */
interface ExtractedTag {
  kind: "function" | "variable" | "class" | "type" | "interface";
  name: string;
  startLine: number;
  endLine: number;
  code: string;
}

/**
 * ScopedFileContext: Aggregates all ExtractedTags from a single file.
 *
 * - filePath: Absolute path to the file.
 * - tags:     Array of ExtractedTag objects found in that file.
 */
interface ScopedFileContext {
  filePath: string;
  tags: ExtractedTag[];
}

/**
 * FileScanner:
 *  - Recursively traverses a directory tree starting at opts.rootDir.
 *  - Skips any file or folder matching patterns from .gitignore/.ignore or extraIgnorePatterns.
 *  - Returns a list of absolute file paths that match the given extensions.
 *
 * Implementation notes:
 *  - Uses the “ignore” library to parse .gitignore/.ignore exactly like Git does.
 *  - Walks directories asynchronously to avoid blocking the event loop on large codebases.
 *  - Immediately prunes ignored subdirectories to improve performance.
 */
class FileScanner {
  private ig = ignore(); // “ignore” instance will hold all ignore patterns.

  constructor(private opts: FileScannerOptions) {
    // 1. Load patterns from each ignore file (if it exists).
    const ignoreFiles = opts.ignoreFiles ?? [".gitignore", ".ignore"];
    for (const igFileName of ignoreFiles) {
      const fullPath = path.join(opts.rootDir, igFileName);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#")); // drop empty lines and comments
        this.ig.add(lines); // tell “ignore” about these patterns
      }
    }

    // 2. Add any extra ignore patterns passed via options.
    if (opts.extraIgnorePatterns && opts.extraIgnorePatterns.length > 0) {
      this.ig.add(opts.extraIgnorePatterns);
    }
  }

  /**
   * scan():
   *   Returns a Promise<string[]> containing all absolute file paths under rootDir
   *   that:
   *     - Are not ignored by the combined patterns
   *     - Have one of the extensions (if opts.extensions is set and non-empty)
   */
  public async scan(): Promise<string[]> {
    const result: string[] = [];
    await this.walk(this.opts.rootDir, result);
    return result;
  }

  /**
   * walk(dir, out):
   *   Internal helper that recursively visits directories.
   *   If a path (file or directory) matches the ignore patterns, it prunes it immediately.
   *   Otherwise, if it is a file with an allowed extension, it is appended to out[].
   */
  private async walk(dir: string, out: string[]): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      // Could be a permissions issue or a broken symlink—just warn and skip.
      console.warn(`⚠️  Cannot read directory ${dir}: ${(e as Error).message}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // Compute a “relative path” from rootDir so that ignore patterns
      // (which are usually relative to rootDir) match correctly.
      const relPath = path.relative(this.opts.rootDir, fullPath);

      // If the relative path matches any ignore pattern, skip this file/directory entirely.
      if (this.ig.ignores(relPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        // Recurse into subdirectory
        await this.walk(fullPath, out);
      } else if (entry.isFile()) {
        // If extensions filter is specified, only include files whose extension matches
        if (this.opts.extensions && this.opts.extensions.length > 0) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!this.opts.extensions.includes(ext)) {
            continue;
          }
        }
        out.push(fullPath);
      }
      // Symbolic links, sockets, etc. are ignored by default
    }
  }
}

/**
 * extractTagsFromFile(filePath):
 *   Reads a single .ts/.tsx/.js/.jsx file and extracts top-level “tags”:
 *     - Named function declarations
 *     - Arrow/function expressions assigned to a variable
 *     - Top-level variable declarations (const/let/var)
 *     - Class declarations
 *     - Type aliases
 *     - Interface declarations
 *
 * Implementation details:
 *   - Uses @babel/parser with plugins for TypeScript, JSX, classProperties, decorators, dynamic imports, etc.
 *   - Uses @babel/traverse to walk the AST and collect nodes that match our criteria.
 *   - Captures location info (line numbers) and exact code snippet for each node’s SourceLocation.
 *   - Returns an array of ExtractedTag objects.
 */
async function extractTagsFromFile(filePath: string): Promise<ExtractedTag[]> {
  // 1. Read the file as UTF-8 text
  const sourceCode = await fs.promises.readFile(filePath, "utf8");
  const tags: ExtractedTag[] = [];

  // 2. Parse the source code into an AST. Enable appropriate plugins for TS/X.
  const ast = parse(sourceCode, {
    sourceType: "module",
    plugins: [
      "typescript",            // parse TypeScript syntax
      "jsx",                   // parse JSX syntax
      "classProperties",       // parse “class Foo { x = 1; }”
      "decorators-legacy",     // parse legacy decorators (@decorator)
      "dynamicImport",         // parse dynamic import(...)
    ],
    errorRecovery: true,       // continue parsing after minor syntax errors
    tokens: false,             // we don’t need tokens for traversal
  });

  // 3. Helper: Given a Babel node’s SourceLocation, return the exact source snippet (lines startLine…endLine).
  const getSnippet = (loc: t.SourceLocation | null | undefined): string => {
    if (!loc) return "";
    const allLines = sourceCode.split(/\r?\n/);
    const startIdx = loc.start.line - 1; // convert 1-based to 0-based
    const endIdx = loc.end.line - 1;     // 0-based
    return allLines.slice(startIdx, endIdx + 1).join("\n").trim();
  };

  // 4. Traverse the AST and collect nodes that match our “tags” criteria
  traverse(ast, {
    // a) Named function declarations: “function foo() { … }”
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      const node = path.node;
      if (!node.id || !node.loc) return; // skip anonymous or invalid
      tags.push({
        kind: "function",
        name: node.id.name,
        startLine: node.loc.start.line,
        endLine: node.loc.end.line,
        code: getSnippet(node.loc),
      });
    },

    // b) Variables that hold arrow/functions (or simple values).
    //    For arrow/function, tag as “function”; else “variable”
    VariableDeclaration(path: NodePath<t.VariableDeclaration>) {
      const node = path.node;
      if (!node.declarations || !node.loc) return;

      for (const decl of node.declarations) {
        // If initializer is a function or arrow function, treat it as a "function"
        if (
          t.isIdentifier(decl.id) &&
          decl.init &&
          (t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init)) &&
          decl.init.loc
        ) {
          // Arrow or function expression assigned to a variable → treat as “function”
          const varName = decl.id.name;
          const loc = decl.init.loc;
          tags.push({
            kind: "function",
            name: varName,
            startLine: loc.start.line,
            endLine: loc.end.line,
            code: getSnippet(loc),
          });
        } else if (
          t.isIdentifier(decl.id) &&
          decl.init &&
          !t.isFunctionExpression(decl.init) &&
          !t.isArrowFunctionExpression(decl.init) &&
          decl.loc
        ) {
          // Simple top-level variable (constant/let/var) → treat as “variable”
          const varName = decl.id.name;
          const loc = decl.loc;
          tags.push({
            kind: "variable",
            name: varName,
            startLine: loc.start.line,
            endLine: loc.end.line,
            code: getSnippet(loc),
          });
        }
      }
    },

    // c) Class declaration: “class Foo { … }”
    ClassDeclaration(path: NodePath<t.ClassDeclaration>) {
      const node = path.node;
      if (!node.id || !node.loc) return;
      tags.push({
        kind: "class",
        name: node.id.name,
        startLine: node.loc.start.line,
        endLine: node.loc.end.line,
        code: getSnippet(node.loc),
      });
    },

    // d) Type alias declarations: “type Foo = …;”
    TSTypeAliasDeclaration(path: NodePath<t.TSTypeAliasDeclaration>) {
      const node = path.node;
      if (!node.id || !node.loc) return;
      tags.push({
        kind: "type",
        name: node.id.name,
        startLine: node.loc.start.line,
        endLine: node.loc.end.line,
        code: getSnippet(node.loc),
      });
    },

    // e) Interface declarations: “interface Foo { … }”
    TSInterfaceDeclaration(path: NodePath<t.TSInterfaceDeclaration>) {
      const node = path.node;
      if (!node.id || !node.loc) return;
      tags.push({
        kind: "interface",
        name: node.id.name,
        startLine: node.loc.start.line,
        endLine: node.loc.end.line,
        code: getSnippet(node.loc),
      });
    },
  });

  return tags;
}

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
    const content = fs.readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(content) as ScopedFileContext[];
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
 * runFullScan(rootDir, scannerOpts):
 *   - Instantiates a new FileScanner with scannerOpts.
 *   - Scans the entire directory tree under rootDir, yielding all file paths.
 *   - For each file path, runs extractTagsFromFile(...) to gather tags.
 *   - Aggregates all ScopedFileContext objects into an array.
 *   - Writes the full index to scoping-tags.json.
 *
 * This is used when no “--update” flag is provided.
 */
async function runFullScan(rootDir: string, scannerOpts: FileScannerOptions) {
  console.log("🔍 Full scan: traversing entire directory…");
  const scanner = new FileScanner(scannerOpts);

  const t0 = process.hrtime.bigint();
  const files = await scanner.scan();
  const t1 = process.hrtime.bigint();
  console.log(
    `➡️  Found ${files.length} source file(s) in ${(Number(t1 - t0) / 1_000_000).toFixed(
      2
    )} ms`
  );

  const contexts: ScopedFileContext[] = [];
  let processed = 0;

  for (const filePath of files) {
    try {
      const tags = await extractTagsFromFile(filePath);
      if (tags.length) {
        contexts.push({ filePath, tags });
      }
    } catch (err) {
      console.warn(`⚠️  Failed to extract tags from ${filePath}: ${(err as Error).message}`);
    }
    processed++;
    if (processed % 50 === 0) {
      console.log(`   • Processed ${processed}/${files.length} files…`);
    }
  }

  writeIndex(rootDir, contexts);
}

/**
 * runIncrementalUpdate(rootDir, scannerOpts, updatePaths):
 *   - Loads existing contexts from scoping-tags.json into a Map (keyed by filePath).
 *   - Iterates over each file in updatePaths:
 *       • Verifies that it exists and has a supported extension.
 *       • Calls extractTagsFromFile(...) to get the new tags array.
 *       • Replaces (or adds) the entry in the Map for that filePath.
 *   - After processing all updatePaths, writes the updated Map back to scoping-tags.json.
 *
 * This enables a quick local update whenever a single file (or a few files) changes,
 * without re-parsing the entire project.
 */
async function runIncrementalUpdate(
  rootDir: string,
  scannerOpts: FileScannerOptions,
  updatePaths: string[]
) {
  console.log("🔄 Incremental update mode for the following file(s):");
  updatePaths.forEach((p) => console.log("   -", p));

  // 1) Load existing index (or get an empty array if the file does not exist)
  const existingContexts: ScopedFileContext[] = loadExistingIndex(rootDir);

  // 2) Build a Map<filePath, ScopedFileContext> for O(1) replacements
  const contextMap = new Map<string, ScopedFileContext>(
    existingContexts.map((ctx) => [ctx.filePath, ctx])
  );

  // 3) Process each file listed in updatePaths
  for (const rawPath of updatePaths) {
    // Resolve to absolute path, relative to rootDir
    const absPath = path.resolve(rootDir, rawPath);

    // 3a) Verify the file actually exists and is a regular file
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      console.warn(`⚠️  Path does not exist or is not a file: ${absPath}. Skipping.`);
      continue;
    }

    // 3b) Enforce extension filtering
    const ext = path.extname(absPath).toLowerCase();
    if (!scannerOpts.extensions?.includes(ext)) {
      console.warn(
        `⚠️  File ${absPath} has unsupported extension "${ext}". Supported: ${JSON.stringify(
          scannerOpts.extensions
        )}. Skipping.`
      );
      continue;
    }

    // 3c) Re-extract tags for this one file
    console.log(`   • Re-extracting tags from: ${absPath}`);
    try {
      const tags = await extractTagsFromFile(absPath);

      // If the file yielded any tags, replace or add its entry.
      // If no tags were found (empty array), we still record {filePath, tags: []}
      // so that the entry is updated to “no tags” (rather than stale data).
      contextMap.set(absPath, { filePath: absPath, tags });
    } catch (err) {
      console.warn(`⚠️  Error parsing ${absPath}: ${(err as Error).message}`);
      // If parsing fails, do NOT delete the existing entry—leave it as it was.
    }
  }

  // 4) Convert the Map back to an array and write to disk
  const updatedContexts: ScopedFileContext[] = Array.from(contextMap.values());
  writeIndex(rootDir, updatedContexts);
}

/**
 * main(): Entry point for the script.
 *
 * 1. Uses yargs.parseSync() to parse CLI flags:
 *     --update <file1> --update <file2> … for incremental updates
 *     --root <dir>                        to specify a custom root directory
 *     (default rootDir = process.cwd())
 *
 * 2. Selects between full rebuild (no --update flag) or incremental update.
 *
 * 3. Delegates to runFullScan() or runIncrementalUpdate() accordingly.
 */
async function main() {
  // 1) Parse CLI arguments using parseSync() for a synchronous result
  const argv = yargs(hideBin(process.argv))
    .option("update", {
      alias: "u",
      type: "array",
      description: "Path(s) to file(s) for incremental update (relative to root)",
    })
    .option("root", {
      alias: "r",
      type: "string",
      description: "Project root directory (defaults to CWD)",
    })
    .help()
    .alias("help", "h")
    .parseSync();

  // 2) Determine the rootDir (defaults to process.cwd())
  const rootDir = argv.root ? path.resolve(String(argv.root)) : process.cwd();

  // 3) Build shared FileScannerOptions
  const scannerOpts: FileScannerOptions = {
    rootDir,
    ignoreFiles: [".gitignore", ".ignore"],
    extraIgnorePatterns: [
      // Common folders and file types to ignore to reduce noise
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
    extensions: [".ts", ".tsx", ".js", ".jsx"],
  };

  // 4) Decide which mode to run
  if (argv.update && Array.isArray(argv.update) && argv.update.length > 0) {
    // Incremental update mode
    // Convert each element to string and pass to runIncrementalUpdate
    const updatePaths = (argv.update as string[]).map((p) => String(p));
    await runIncrementalUpdate(rootDir, scannerOpts, updatePaths);
  } else {
    // Full rebuild mode
    await runFullScan(rootDir, scannerOpts);
  }
}

// Kick off main(); catch and log any unexpected errors
main().catch((err) => {
  console.error("❌ Uncaught error in scanner:", err);
  process.exit(1);
});
