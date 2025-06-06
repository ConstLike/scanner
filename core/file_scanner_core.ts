// core/file_scanner_core.ts

import * as fs from "fs";
import * as path from "path";
import ignore from "ignore";

///
// ScannerOptions: configuration for the core file scanner.
//
// - rootDir: absolute project root or directory to scan.
// - ignoreFiles: optional array of filenames (like ".gitignore", ".ignore") to read patterns from.
// - extraIgnorePatterns: additional glob-ish patterns to ignore (e.g. "dist/", "**/*.log").
// - extensions: if non-empty, only files whose extension (lowercased) appears here will be returned.
///
export interface ScannerOptions {
  rootDir: string;
  ignoreFiles?: string[];
  extraIgnorePatterns?: string[];
  extensions?: string[];
}

/**
 * FileScannerCore: recursively walks rootDir, applies ignore rules,
 * and returns a list of absolute file paths whose extensions match `opts.extensions`.
 *
 * Implementation notes:
 * - Uses the “ignore” library to parse .gitignore/.ignore exactly like Git does.
 * - Walks directories asynchronously to avoid blocking the event loop on large codebases.
 * - Immediately prunes ignored subdirectories to improve performance.
 */
export class FileScannerCore {
  private ig = ignore(); // “ignore” instance will hold all ignore patterns.

  constructor(private opts: ScannerOptions) {
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
   *   1. do not match any ignore pattern (relative to rootDir)
   *   2. if opts.extensions is non-empty, their extension (lowercase) appears in opts.extensions.
   */
  public async scan(): Promise<string[]> {
    const result: string[] = [];
    await this.walk(this.opts.rootDir, result);
    return result;
  }

  /**
   * walk(dir, out):
   *   Internal helper that recursively reads `dir`.
   *   If a relative path (file or directory) matches the ignore patterns, it prunes it immediately.
   *   Otherwise, if it is a file with an allowed extension,
   *   we push its absolute path into `out`.
   */
  private async walk(dir: string, out: string[]): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      // Could be a permissions issue or a broken symlink—just warn and skip.
      console.warn(`⚠️ Cannot read directory ${dir}: ${(e as Error).message}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // Compute a relative path from rootDir so that
      // ignore patterns (which are usually relative to rootDir) match correctly.
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
