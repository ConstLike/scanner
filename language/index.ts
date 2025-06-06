/**
 * @file language/index.ts
 * @description Registry of language scanners and utility functions.
 * @author Konstantin Komarov <constlike@gmail.com>
 */

import { LanguageScanner } from "../types/tags";
import { TypeScriptScanner } from "./scanner_ts";
import { FortranScanner } from "./scanner_fortran";

/**
 * Map of language identifiers to their corresponding scanner instances.
 *
 * @constant
 */
export const ALL_SCANNERS: { [lang: string]: LanguageScanner } = {
  typescript: new TypeScriptScanner(),
  fortran: new FortranScanner(),
  // Once ready, add:
  // python: new PythonScanner(),
  // rust: new RustScanner(),
  // lang: new LangScanner(),
};

/**
 * Retrieves the list of active scanners based on requested languages.
 *
 * @param requestedLangs - Array of language identifiers or null for all scanners.
 * @returns Array of active LanguageScanner instances.
 */
export function getActiveScanners(requestedLangs: string[] | null): LanguageScanner[] {
  if (!requestedLangs || requestedLangs.length === 0) {
    return Object.values(ALL_SCANNERS);
  }
  const chosen: LanguageScanner[] = [];
  for (const lang of requestedLangs) {
    const scanner = ALL_SCANNERS[lang.toLowerCase()];
    if (scanner) {
      chosen.push(scanner);
    } else {
      console.warn(`⚠️ Language adapter "${lang}" not found; skipping.`);
    }
  }
  return chosen;
}

/**
 * Collects a deduplicated list of supported extensions from the given scanners.
 *
 * @param scanners - Array of LanguageScanner instances.
 * @returns Array of lowercase file extensions.
 */
export function collectExtensions(scanners: LanguageScanner[]): string[] {
  const extSet = new Set<string>();
  for (const scanner of scanners) {
    for (const ext of scanner.supportedExtensions()) {
      extSet.add(ext.toLowerCase());
    }
  }
  return Array.from(extSet);
}
