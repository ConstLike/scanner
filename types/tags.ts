// types/tags.ts

/**
 * ExtractedTag: represents a single “tag” (function, variable, class, type, interface, etc.) 
 * found inside a source file.
 */
export interface ExtractedTag {
  kind: "function" | "variable" | "class" | "type" | "interface";
  name: string;
  startLine: number;
  endLine: number;
  code: string;
}

/**
 * ScopedFileContext: collects all tags extracted from one file, 
 * plus the language identifier.
 */
export interface ScopedFileContext {
  filePath: string;    // absolute path
  language: string;    // e.g. "typescript"
  tags: ExtractedTag[]; 
}

/**
 * LanguageScanner: adapter interface for each language.
 * Each adapter must:
 *  1. report which file extensions it supports
 *  2. provide extractTags(filePath) that returns any tags found
 */
export interface LanguageScanner {
  /** Return all lowercase extensions (including leading dot) that this scanner handles. */
  supportedExtensions(): string[];

  /**
   * Given an absolute file path, parse it and return an array of ExtractedTag.
   * If file is not of this language or contains no tags, return an empty array
   * rather than throwing.
   */
  extractTags(filePath: string): Promise<ExtractedTag[]>;
}

