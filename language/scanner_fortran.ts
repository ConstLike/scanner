/**
 * @file language/scanner_fortran.ts
 * @description Language scanner implementation for Fortran source files.
 * @author Konstantin Komarov <constlike@gmail.com>
 */

import * as fs from "fs";
import * as path from "path";
import { LanguageScanner, ExtractedTag } from "../types/tags";

/**
 * Type representing the kinds of Fortran constructs that can be extracted.
 *
 * @typedef {string} FortranKind
 */
type FortranKind = "program" | "module" | "subroutine" | "function" | "type";

/**
 * Implements the LanguageScanner interface for Fortran source files.
 *
 * This scanner supports various Fortran file extensions and extracts tags for key constructs
 * such as programs, modules, subroutines, functions, and user-defined types.
 *
 * @class FortranScanner
 * @implements {LanguageScanner}
 */
export class FortranScanner implements LanguageScanner {
  /**
   * Returns the list of file extensions supported by this scanner.
   *
   * @returns Array of supported Fortran file extensions (case-insensitive).
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
   * Processes the file in a single pass, handling both free-form and fixed-form syntax,
   * and tracks nested constructs using a stack-based approach.
   *
   * @param filePath - Absolute path to the Fortran source file.
   * @returns A promise resolving to an array of extracted tags, or an empty array if unreadable.
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
      { kind: "type", regex: /^\s*type\s+(\w+)/i },
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
          };
          stack.push(newTag);
          break;
        }
      }

      // Check if the line ends a construct
      const endMatch = /^\s*end\s*(\w+)?/.exec(codePart);
      if (endMatch) {
        const endKind = endMatch[1];
        if (stack.length > 0) {
          const topTag = stack[stack.length - 1];
          if (!endKind || endKind.toLowerCase() === topTag.kind) {
            // End the tag if it is just "END" or "END <type>" matches the type on the top of the stack
            const tag = stack.pop()!;
            tag.endLine = i + 1;
            tag.code = originalLines.slice(tag.startLine! - 1, i + 1).join("\n").trim();
            tags.push(tag as ExtractedTag);
          }
          // Otherwise, we ignore, for example, "END DO" for a subroutine
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
