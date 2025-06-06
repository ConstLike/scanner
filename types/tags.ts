/**
 * @file types/tags.ts
 * @description Type definitions for extracted tags and language scanners.
 * @author Konstantin Komarov <constlike@gmail.com>
 */

/**
 * Represents a single tag extracted from a source file.
 *
 * @interface ExtractedTag
 * @property {string} kind - The type of the tag (e.g., "function", "class").
 * @property {string} name - The name of the tag.
 * @property {number} startLine - The 1-based line number where the definition starts.
 * @property {number} endLine - The 1-based line number where the definition ends.
 * @property {string} code - The exact source snippet of the tag, trimmed.
 */
export interface ExtractedTag {
  kind:
    | "function"
    | "variable"
    | "class"
    | "type"
    | "interface"
    | "program"
    | "module"
    | "subroutine";
  name: string;
  startLine: number;   // 1-based line number where the definition starts
  endLine: number;     // 1-based line number where the definition ends
  code: string;        // Exact source snippet (trimmed of leading/trailing whitespace)
}

/**
 * Collects all tags extracted from a single file along with language metadata.
 *
 * @interface ScopedFileContext
 * @property {string} filePath - Absolute path to the file.
 * @property {string} language - Language identifier (e.g., "typescript").
 * @property {ExtractedTag[]} tags - Array of extracted tags from the file.
 */
export interface ScopedFileContext {
  filePath: string;    // absolute path
  language: string;    // e.g. "typescript", "fortran"
  tags: ExtractedTag[];
}

/**
 * Defines the interface for language-specific scanners.
 *
 * @interface LanguageScanner
 */
export interface LanguageScanner {
  /**
   * Returns the list of supported file extensions.
   *
   * @returns Array of lowercase extensions (including leading dot).
   */
  supportedExtensions(): string[];

  /**
   * Extracts tags from a given file.
   *
   * @param filePath - Absolute path to the file.
   * @returns A promise resolving to an array of extracted tags.
   */
  extractTags(filePath: string): Promise<ExtractedTag[]>;
}

