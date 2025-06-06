// language/scanner_ts.ts

import * as fs from "fs";
import * as path from "path";
import { parse } from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { LanguageScanner, ExtractedTag } from "../types/tags";

/**
 * TypeScriptScanner: implements LanguageScanner for TypeScript/JavaScript.
 * 
 * Supported extensions: [".ts", ".tsx", ".js", ".jsx"].
 * 
 * Uses @babel/parser (plugins: typescript, jsx, classProperties, decorators-legacy, dynamicImport),
 * and @babel/traverse to find:
 *  - FunctionDeclaration
 *  - ArrowFunctionExpression / FunctionExpression assigned to a variable
 *  - VariableDeclaration (non-function initializers)
 *  - ClassDeclaration
 *  - TSTypeAliasDeclaration
 *  - TSInterfaceDeclaration
 */
export class TypeScriptScanner implements LanguageScanner {
  /**
   * Return the list of file extensions (lowercase) supported by this adapter.
   */
  supportedExtensions(): string[] {
    return [".ts", ".tsx", ".js", ".jsx"];
  }

  /**
   * extractTags(filePath):
   *  - Reads sourceCode as UTF-8.
   *  - Parses with @babel/parser (TypeScript + JSX support).
   *  - Traverses the AST collecting ExtractedTag entries.
   *  - Returns [] if file is unparsable or contains no tags.
   */
  async extractTags(filePath: string): Promise<ExtractedTag[]> {
    // 1. Quick extension check
    const ext = path.extname(filePath).toLowerCase();
    if (!this.supportedExtensions().includes(ext)) {
      return [];
    }

    // 2. Read the file as UTF-8 text
    let sourceCode: string;
    try {
      sourceCode = await fs.promises.readFile(filePath, "utf8");
    } catch {
      // If we can’t read, just return empty
      return [];
    }

    // 3. Parse with Babel parser
    let ast;
    try {
      ast = parse(sourceCode, {
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
    } catch {
      // If parsing fails entirely, return empty
      return [];
    }

    const tags: ExtractedTag[] = [];

    // 4. Helper to extract code snippet from loc
    const getSnippet = (loc: t.SourceLocation | null | undefined): string => {
      if (!loc) return "";
      const lines = sourceCode.split(/\r?\n/);
      const startIdx = loc.start.line - 1; // convert 1-based to 0-based
      const endIdx = loc.end.line - 1;     // 0-based
      return lines.slice(startIdx, endIdx + 1).join("\n").trim();
    };

    // 5. Traverse AST and collect nodes
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
          // If initializer is a function or arrow function, mark as “function”
          if (
            t.isIdentifier(decl.id) &&
            decl.init &&
            (t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init)) &&
            decl.init.loc
          ) {
            tags.push({
              kind: "function",
              name: decl.id.name,
              startLine: decl.init.loc.start.line,
              endLine: decl.init.loc.end.line,
              code: getSnippet(decl.init.loc),
            });
          }
          // Otherwise, if initializer is present, mark as “variable”
          else if (
            t.isIdentifier(decl.id) &&
            decl.init &&
            !t.isArrowFunctionExpression(decl.init) &&
            !t.isFunctionExpression(decl.init) &&
            decl.loc
          ) {
            tags.push({
              kind: "variable",
              name: decl.id.name,
              startLine: decl.loc.start.line,
              endLine: decl.loc.end.line,
              code: getSnippet(decl.loc),
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
}
