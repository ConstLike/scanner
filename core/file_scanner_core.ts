/**
 * @file core/file_scanner_core.ts
 * @description Core file scanner for recursively walking directories and applying ignore rules.
 * @author Konstantin Komarov <constlike@gmail.com>
 */

import * as fs from "fs";
import * as path from "path";
import ignore from "ignore";

/**
 * Configuration options for the core file scanner.
 *
 * @interface ScannerOptions
 * @property {string} rootDir - Absolute project root or directory to scan.
 * @property {string[]} [ignoreFiles] - Optional array of filenames (like ".gitignore", ".ignore") to read ignore patterns from.
 * @property {string[]} [extraIgnorePatterns] - Additional glob-ish patterns to ignore (e.g., "dist/", "*.log").
 * @property {string[]} [extensions] - If non-empty, only files with these extensions (lowercased) will be returned.
 */
export interface ScannerOptions {
  rootDir: string;
  ignoreFiles?: string[];
  extraIgnorePatterns?: string[];
  extensions?: string[];
}

/**
 * Recursively walks the root directory, applies ignore rules, and returns a list of absolute file paths
 * that match the specified extensions.
 *
 * This class uses the "ignore" library to parse .gitignore and .ignore files exactly like Git does.
 * It walks directories asynchronously to avoid blocking the event loop on large codebases and
 * immediately prunes ignored subdirectories to improve performance.
 *
 * @class FileScannerCore
 */
export class FileScannerCore {
  private ig = ignore(); // “ignore” instance will hold all ignore patterns.

  /**
   * Creates a new FileScannerCore instance with the given options.
   *
   * @param opts - The configuration options for the scanner.
   */
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
   * Scans the directory and returns a list of absolute file paths that match the criteria.
   *
   * The returned files do not match any ignore patterns and, if extensions are specified,
   * have extensions included in opts.extensions.
   *
   * @returns A promise that resolves to an array of absolute file paths.
   */
  public async scan(): Promise<string[]> {
    const result: string[] = [];
    await this.walk(this.opts.rootDir, result);
    return result;
  }

  /**
   * Recursively walks the directory and collects file paths that match the criteria.
   *
   * @private
   * @param dir - The current directory to walk.
   * @param out - The array to collect matching file paths.
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
