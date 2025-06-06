// language/scanner_fortran.ts

import * as fs from "fs";
import * as path from "path";
import { LanguageScanner, ExtractedTag } from "../types/tags";

/**
 * Type representing the kinds of Fortran constructs that can be extracted.
 */
type FortranKind = "program" | "module" | "subroutine" | "function" | "type";

/**
 * FortranScanner: Implements LanguageScanner for Fortran source files.
 *
 * This scanner supports a variety of Fortran file extensions and extracts tags for
 * key constructs such as programs, modules, subroutines, functions, and user-defined types.
 * It processes files in a single pass, handling both free-form and fixed-form syntax,
 * and accounts for nested constructs using a stack-based approach. Comments are
 * appropriately ignored in both formats.
 *
 * Supported extensions (case-insensitive):
 *   - .f, .for, .f90, .f95, .f03, .f08, .fpp
 *   - .F, .FOR, .F90, .F95, .F03, .F08, .FPP
 *
 * Extracted constructs:
 *   - program
 *   - module
 *   - subroutine
 *   - function
 *   - type (user-defined types)
 */
export class FortranScanner implements LanguageScanner {
  /**
   * Returns the list of file extensions supported by this scanner.
   * Includes both lowercase and uppercase variants to account for case-sensitive file systems.
   *
   * @returns Array of supported Fortran file extensions.
   */
  supportedExtensions(): string[] {
    return [
      ".f", ".for", ".f90", ".f95", ".f03", ".f08", ".fpp",
      ".F", ".FOR", ".F90", ".F95", ".F03", ".F08", ".FPP",
      // You can add more as needed
    ];
  }

  /**
   * Extracts tags from a Fortran source file.
   *
   * This method reads the file, identifies Fortran constructs using regular expressions,
   * and tracks their scope using a stack. It handles nested constructs and ignores
   * comments (both full-line and inline). Each extracted tag includes the construct
   * kind, name, start and end line numbers, and the corresponding code snippet.
   *
   * @param filePath - Absolute path to the Fortran source file.
   * @returns A promise resolving to an array of ExtractedTag objects,
   *          or an empty array if the file is invalid or unreadable.
   */
  async extractTags(filePath: string): Promise<ExtractedTag[]> {
    // Validate file extension to ensure it matches supported Fortran extensions
    const ext = path.extname(filePath).toLowerCase();
    if (!this.supportedExtensions().includes(ext)) {
      return [];
    }

    // Read the file content asynchronously
    let source: string;
    try {
      source = await fs.promises.readFile(filePath, "utf8");
    } catch (error) {
      console.error(`Failed to read file ${filePath}: ${error}`);
      return [];
    }

    // Split the source into lines and initialize collections for tags and stack
    const originalLines = source.split(/\r?\n/);
    const tags: ExtractedTag[] = [];
    const stack: Partial<ExtractedTag>[] = [];

    // Define patterns for detecting Fortran constructs
    const patterns: { kind: FortranKind; regex: RegExp }[] = [
      { kind: "program", regex: /^\s*program\s+(\w+)/i },
      { kind: "module", regex: /^\s*module\s+(\w+)/i },
      { kind: "subroutine", regex: /^\s*subroutine\s+(\w+)/i },
      { kind: "function", regex: /^\s*function\s+(\w+)/i },
      { kind: "type", regex: /^\s*type\s+(\w+)/i }
    ];

    // Process each line of the file
    for (let i = 0; i < originalLines.length; i++) {
      const line = originalLines[i];

      // Skip lines that are comments in fixed-form Fortran (starting with c, C, *, or !)
      if (/^\s*[cC\*!]/.test(line)) {
        continue;
      }

      // Extract the code part before an inline comment (!) and normalize to lowercase
      const codePart = line.split("!")[0].trim().toLowerCase();
      if (codePart === "") continue;

      // Check if the line starts a new Fortran construct
      for (const { kind, regex } of patterns) {
        const match = regex.exec(codePart);
        if (match && match[1]) {
          // Create a new tag and push it onto the stack
          const newTag: Partial<ExtractedTag> = {
            kind: kind,
            name: match[1],
            startLine: i + 1, // Line numbers are 1-based
            code: ""
          };
          stack.push(newTag);
          break;
        }
      }

      // Check if the line ends a construct
      if (/^\s*end\b/.test(codePart)) {
        if (stack.length > 0) {
          // Pop the tag from the stack, finalize it, and add to the tags list
          const tag = stack.pop()!;
          tag.endLine = i + 1;
          tag.code = originalLines.slice(tag.startLine! - 1, i + 1).join("\n").trim();
          tags.push(tag as ExtractedTag);
        }
      }
    }

    // Close any remaining open constructs at the end of the file
    while (stack.length > 0) {
      const tag = stack.pop()!;
      tag.endLine = originalLines.length;
      tag.code = originalLines.slice(tag.startLine! - 1).join("\n").trim();
      tags.push(tag as ExtractedTag);
    }

    // Return the list of extracted tags
    return tags;
  }
}
