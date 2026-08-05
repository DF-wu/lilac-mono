import { createHash } from "node:crypto";
import path from "node:path";

import ts from "typescript-codegen";

import type { ArchitectureRule } from "./model.ts";

export interface FingerprintInput {
  readonly workspace: string;
  readonly rule: ArchitectureRule;
  readonly module: string;
  readonly symbolPath: string;
  readonly node: ts.Node;
}

function normalizedStructuralContext(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const tokens: string[] = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    node.getText(sourceFile),
  );

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.WhitespaceTrivia || token === ts.SyntaxKind.NewLineTrivia) continue;
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    tokens.push(scanner.getTokenText());
  }
  return tokens.join(" ");
}

function callablePart(node: ts.Node): string | undefined {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
    return node.name?.text ?? "<class>";
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && node.name) return node.name.getText();
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
    return node.name.getText();
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (node.name) return node.name.text;
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name))
      return node.parent.name.text;
    if (ts.isPropertyAssignment(node.parent)) return node.parent.name.getText();
    return "<callback>";
  }
  return undefined;
}

function lexicalSymbolPath(node: ts.Node): string {
  const parts: string[] = [];
  for (
    let current: ts.Node | undefined = node;
    current && !ts.isSourceFile(current);
    current = current.parent
  ) {
    const part = callablePart(current);
    if (part) parts.unshift(part);
  }
  return parts.join(".") || "<module>";
}

function structuralOccurrence(input: FingerprintInput): number {
  const { node } = input;
  const context = normalizedStructuralContext(node);
  let occurrence = 0;
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (candidate === node) {
      found = true;
      return;
    }
    if (
      candidate.kind === node.kind &&
      lexicalSymbolPath(candidate) === input.symbolPath &&
      normalizedStructuralContext(candidate) === context
    ) {
      occurrence += 1;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node.getSourceFile());
  return occurrence + 1;
}

export function createFingerprintIdentity(input: FingerprintInput): string {
  const kind = ts.SyntaxKind[input.node.kind];
  const site = structuralOccurrence(input);
  return `${input.module}#${input.symbolPath}[${kind}]@${site}`;
}

export function createFingerprint(input: FingerprintInput): string {
  const context = normalizedStructuralContext(input.node);
  const identity = createFingerprintIdentity(input);
  const digest = createHash("sha256")
    .update(`${input.workspace}\0${input.rule}\0${identity}\0${context}`)
    .digest("hex");
  return [
    "arch-v2",
    `workspace=${encodeURIComponent(input.workspace)}`,
    `rule=${encodeURIComponent(input.rule)}`,
    `identity=${encodeURIComponent(identity)}`,
    `sha256=${digest}`,
  ].join("|");
}

export function relativeModulePath(workspaceRoot: string, sourceFile: ts.SourceFile): string {
  return path.relative(workspaceRoot, sourceFile.fileName).split(path.sep).join("/");
}
