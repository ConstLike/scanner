// language/index.ts

import { LanguageScanner } from "../types/tags";
import { TypeScriptScanner } from "./scanner_ts";

/**
 * ALL_SCANNERS: map from language identifier → LanguageScanner instance.
 * Currently only "typescript" is registered. Future adapters can be added here.
 */
const ALL_SCANNERS: { [lang: string]: LanguageScanner } = {
  typescript: new TypeScriptScanner(),
  // Once ready, add:
  // python: new PythonScanner(),
  // fortran: new FortranScanner(),
  // rust: new RustScanner(),
};

/**
 * getActiveScanners(requestedLangs):
 *   If requestedLangs is null or empty, return all adapters (Object.values).
 *   Otherwise, for each lang in requestedLangs, return its adapter if exists.
 *   Warn if an adapter is not found.
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
 * collectExtensions(scanners):
 *   Return a de-duplicated array of all extensions supported by these scanners.
 *   Lowercases everything to keep consistency.
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
