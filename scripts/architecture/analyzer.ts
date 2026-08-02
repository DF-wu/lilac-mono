import path from "node:path";

import ts from "typescript-codegen";

import { createFingerprint, createFingerprintIdentity, relativeModulePath } from "./fingerprint.ts";
import type { CompatibilitySink, SymbolIdentity, WorkspaceArchitecture } from "./manifest.ts";
import { ARCHITECTURE_RULES, type ArchitectureDiagnostic, type ArchitectureRule } from "./model.ts";
import { isProductionFileName } from "./source-policy.ts";

interface NodeIdentity extends SymbolIdentity {
  readonly symbolPath: string;
}

export interface WorkspacePackageRoot {
  readonly packageName: string;
  readonly root: string;
}

const ZOD_PARSE_MEMBERS = new Set(["parse", "parseAsync", "safeParse", "safeParseAsync"]);
const UNSAFE_RESULT_MEMBERS = new Set(["deserializeUnsafe", "serializeUnsafe", "unwrap"]);
const RESULT_CAPTURE_MEMBERS = new Set(["try", "tryPromise"]);
const MAX_TYPE_DEPTH = 6;
const MAX_VISITED_PROPERTIES = 256;

function normalizedPath(value: string): string {
  return value.split(path.sep).join("/");
}

function canonicalPath(value: string): string {
  return normalizedPath(path.resolve(ts.sys.realpath?.(value) ?? value));
}

function isProductionSource(sourceFile: ts.SourceFile, workspaceRoot: string): boolean {
  return !sourceFile.isDeclarationFile && isProductionFileName(sourceFile.fileName, workspaceRoot);
}

function matchesPattern(file: string, pattern: string): boolean {
  if (pattern === "**") return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3).replace(/\/$/u, "");
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${expression}$`, "u").test(file);
}

function ruleApplies(
  workspace: WorkspaceArchitecture,
  rule: ArchitectureRule,
  module: string,
): boolean {
  return (workspace.ruleZones[rule] ?? []).some((zone) => matchesPattern(module, zone.include));
}

function expressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    (ts.isStringLiteral(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
  ) {
    return expression.argumentExpression.text;
  }
  if (ts.isParenthesizedExpression(expression)) return expressionName(expression.expression);
  return undefined;
}

function callCandidateNames(
  sourceFile: ts.SourceFile,
  workspace: WorkspaceArchitecture,
  activeRules: ReadonlySet<ArchitectureRule>,
): ReadonlySet<string> {
  const names = new Set<string>();
  if (activeRules.has("architecture/no-unregistered-decoder")) {
    for (const name of ZOD_PARSE_MEMBERS) names.add(name);
  }
  if (activeRules.has("architecture/no-production-unwrap")) {
    for (const name of UNSAFE_RESULT_MEMBERS) names.add(name);
  }
  if (activeRules.has("architecture/no-unmapped-result-capture")) {
    for (const name of RESULT_CAPTURE_MEMBERS) names.add(name);
  }
  if (activeRules.has("architecture/registered-panic-site")) names.add("panic");
  if (activeRules.has("architecture/no-result-wire-leak")) {
    names.add("stringify");
    for (const output of workspace.compatibilityOutputs) names.add(output.sink.exportName);
  }
  if (activeRules.has("architecture/no-unredacted-tagged-error-log")) {
    names.add("stringify");
    names.add("toJSON");
    for (const logger of workspace.structuredLoggers) names.add(logger.sink.exportName);
  }

  const aliases: Array<readonly [source: string, target: string]> = [];
  const addAlias = (source: string | undefined, target: ts.BindingName | ts.PropertyName): void => {
    if (!source || !ts.isIdentifier(target)) return;
    aliases.push([source, target.text]);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      aliases.push([node.propertyName?.text ?? node.name.text, node.name.text]);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      addAlias(expressionName(node.initializer), node.name);
    } else if (ts.isBindingElement(node)) {
      const source = node.propertyName;
      if (source && (ts.isIdentifier(source) || ts.isStringLiteral(source))) {
        addAlias(source.text, node.name);
      }
    } else if (ts.isPropertyAssignment(node)) {
      addAlias(expressionName(node.initializer), node.name);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      addAlias(expressionName(node.right), node.left);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [source, target] of aliases) {
      if (!names.has(source) || names.has(target)) continue;
      names.add(target);
      changed = true;
    }
  }
  return names;
}

function declarationName(node: ts.Node | undefined): string | undefined {
  for (let current = node; current; current = current.parent) {
    if (
      (ts.isMethodDeclaration(current) ||
        ts.isMethodSignature(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isPropertySignature(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isVariableDeclaration(current)) &&
      current.name
    ) {
      if (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name))
        return current.name.text;
    }
  }
  return undefined;
}

export function declarationPackageName(
  node: ts.Node | undefined,
  packageRoots: readonly WorkspacePackageRoot[],
): string | undefined {
  if (!node) return undefined;
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name))
      return current.name.text;
  }

  const sourceFile = node.getSourceFile().fileName;
  const file = canonicalPath(sourceFile);
  const workspacePackage = packageRoots
    .map((candidate) => ({ ...candidate, root: canonicalPath(candidate.root) }))
    .sort((left, right) => right.root.length - left.root.length)
    .find((candidate) => file === candidate.root || file.startsWith(`${candidate.root}/`));
  if (workspacePackage) return workspacePackage.packageName;

  const marker = "/node_modules/";
  const index = file.lastIndexOf(marker);
  if (index < 0) return undefined;
  const packagePath = file.slice(index + marker.length).split("/");
  if (packagePath[0]?.startsWith("@")) return packagePath.slice(0, 2).join("/");
  return packagePath[0];
}

function packageForSignature(
  signature: ts.Signature | undefined,
  packageRoots: readonly WorkspacePackageRoot[],
): string | undefined {
  return declarationPackageName(signature?.declaration, packageRoots);
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

function nodeIdentity(node: ts.Node, workspaceRoot: string): NodeIdentity {
  const parts: string[] = [];
  for (
    let current: ts.Node | undefined = node;
    current && !ts.isSourceFile(current);
    current = current.parent
  ) {
    const part = callablePart(current);
    if (part) parts.unshift(part);
  }
  let signatureContractPath: string | undefined;
  if (
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isFunctionTypeNode(node)
  ) {
    let container: ts.Node | undefined = node.parent;
    while (
      container &&
      !ts.isInterfaceDeclaration(container) &&
      !ts.isTypeAliasDeclaration(container)
    ) {
      container = container.parent;
    }
    if (
      container &&
      (ts.isInterfaceDeclaration(container) || ts.isTypeAliasDeclaration(container))
    ) {
      const member = ts.isMethodSignature(node) ? node.name.getText() : "<call>";
      signatureContractPath = `${container.name.text}.${member}`;
    }
  }
  const declaredContractName =
    ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? node.name.text : undefined;
  const symbolPath = parts.join(".") || signatureContractPath || declaredContractName || "<module>";
  return {
    module: relativeModulePath(workspaceRoot, node.getSourceFile()),
    exportName:
      parts[0] ?? signatureContractPath?.split(".")[0] ?? declaredContractName ?? "<module>",
    symbolPath,
  };
}

function identityOwns(owner: SymbolIdentity, candidate: NodeIdentity): boolean {
  return (
    owner.module === candidate.module &&
    (candidate.symbolPath === owner.exportName ||
      candidate.symbolPath.startsWith(`${owner.exportName}.`))
  );
}

function identityMatches(owner: SymbolIdentity, candidate: NodeIdentity): boolean {
  return owner.module === candidate.module && owner.exportName === candidate.symbolPath;
}

function parameterContractIdentity(
  node: ts.ParameterDeclaration,
  workspaceRoot: string,
): NodeIdentity | undefined {
  const signature = node.parent;
  if (
    !ts.isMethodSignature(signature) &&
    !ts.isCallSignatureDeclaration(signature) &&
    !ts.isFunctionTypeNode(signature)
  ) {
    return undefined;
  }
  return nodeIdentity(signature, workspaceRoot);
}

function isUnknown(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Unknown) !== 0;
}

function isStructured(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) !== 0) return true;
  if (type.isUnionOrIntersection()) return type.types.some(isStructured);
  return false;
}

function symbolComesFromPackage(
  symbol: ts.Symbol | undefined,
  packageName: string,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  return (
    symbol?.declarations?.some(
      (declaration) => declarationPackageName(declaration, packageRoots) === packageName,
    ) ?? false
  );
}

interface TypeTraversalState {
  readonly seen: Set<ts.Type>;
  remainingProperties: number;
}

function typeArguments(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  const argumentsFromAlias = type.aliasTypeArguments ?? [];
  if ((type.flags & ts.TypeFlags.Object) === 0) return argumentsFromAlias;
  const objectType = type as ts.ObjectType;
  if ((objectType.objectFlags & ts.ObjectFlags.Reference) === 0) return argumentsFromAlias;
  return [...argumentsFromAlias, ...checker.getTypeArguments(objectType as ts.TypeReference)];
}

function baseTypes(type: ts.Type): readonly ts.BaseType[] {
  if ((type.flags & ts.TypeFlags.Object) === 0) return [];
  const objectType = type as ts.ObjectType;
  if ((objectType.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) === 0) return [];
  return objectType.getBaseTypes() ?? [];
}

function typeContainsPackageType(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  packageName: string,
  symbolNames: ReadonlySet<string>,
  location: ts.Node,
  state: TypeTraversalState = { seen: new Set(), remainingProperties: MAX_VISITED_PROPERTIES },
  depth = 0,
): boolean {
  if (depth > MAX_TYPE_DEPTH || state.seen.has(type)) return false;
  state.seen.add(type);

  if (
    symbolComesFromPackage(type.aliasSymbol, packageName, packageRoots) ||
    symbolComesFromPackage(type.getSymbol(), packageName, packageRoots)
  ) {
    const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
    if (name && symbolNames.has(name)) return true;
  }
  if (
    type.isUnionOrIntersection() &&
    type.types.some((member) =>
      typeContainsPackageType(
        member,
        checker,
        packageRoots,
        packageName,
        symbolNames,
        location,
        state,
        depth + 1,
      ),
    )
  ) {
    return true;
  }

  if (
    typeArguments(type, checker).some((argument) =>
      typeContainsPackageType(
        argument,
        checker,
        packageRoots,
        packageName,
        symbolNames,
        location,
        state,
        depth + 1,
      ),
    )
  ) {
    return true;
  }

  if (
    baseTypes(type).some((baseType) =>
      typeContainsPackageType(
        baseType,
        checker,
        packageRoots,
        packageName,
        symbolNames,
        location,
        state,
        depth + 1,
      ),
    )
  ) {
    return true;
  }

  const constraint = checker.getBaseConstraintOfType(type);
  if (
    constraint &&
    constraint !== type &&
    typeContainsPackageType(
      constraint,
      checker,
      packageRoots,
      packageName,
      symbolNames,
      location,
      state,
      depth + 1,
    )
  ) {
    return true;
  }

  for (const property of checker.getPropertiesOfType(type)) {
    if (state.remainingProperties <= 0) return false;
    if (
      property.declarations?.every(
        (declaration) =>
          ts.isMethodDeclaration(declaration) ||
          ts.isMethodSignature(declaration) ||
          ts.isFunctionDeclaration(declaration),
      )
    ) {
      continue;
    }
    state.remainingProperties -= 1;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, location);
    if (
      typeContainsPackageType(
        propertyType,
        checker,
        packageRoots,
        packageName,
        symbolNames,
        location,
        state,
        depth + 1,
      )
    ) {
      return true;
    }
  }

  const apparent = checker.getApparentType(type);
  return (
    apparent !== type &&
    typeContainsPackageType(
      apparent,
      checker,
      packageRoots,
      packageName,
      symbolNames,
      location,
      state,
      depth + 1,
    )
  );
}

function typeContainsBetterResult(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  const resultNames = new Set(["AnyTaggedError", "Err", "Ok", "Result", "TaggedErrorInstance"]);
  if (
    typeContainsPackageType(type, checker, packageRoots, "better-result", resultNames, location)
  ) {
    return true;
  }
  const tag = type.getProperty("_tag");
  const match = type.getProperty("match");
  return Boolean(tag && symbolComesFromPackage(match, "better-result", packageRoots));
}

function typeContainsResult(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  return typeContainsPackageType(
    type,
    checker,
    packageRoots,
    "better-result",
    new Set(["Err", "Ok", "Result"]),
    location,
  );
}

function typeContainsUnhandledException(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  return typeContainsPackageType(
    type,
    checker,
    packageRoots,
    "better-result",
    new Set(["UnhandledException"]),
    location,
  );
}

function typeContainsTaggedError(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  if (
    typeContainsPackageType(
      type,
      checker,
      packageRoots,
      "better-result",
      new Set(["AnyTaggedError", "TaggedErrorInstance"]),
      location,
    )
  ) {
    return true;
  }
  const toJSON = type.getProperty("toJSON");
  return Boolean(
    type.getProperty("_tag") && symbolComesFromPackage(toJSON, "better-result", packageRoots),
  );
}

function typeIsTaggedError(
  type: ts.Type,
  packageRoots: readonly WorkspacePackageRoot[],
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (
    typeIsPackageType(
      type,
      "better-result",
      new Set(["AnyTaggedError", "TaggedErrorInstance"]),
      packageRoots,
    )
  ) {
    return true;
  }
  const toJSON = type.getProperty("toJSON");
  if (type.getProperty("_tag") && symbolComesFromPackage(toJSON, "better-result", packageRoots)) {
    return true;
  }
  if (
    type.isUnionOrIntersection() &&
    type.types.some((member) => typeIsTaggedError(member, packageRoots, seen))
  ) {
    return true;
  }
  return baseTypes(type).some((baseType) => typeIsTaggedError(baseType, packageRoots, seen));
}

function typeIsPackageType(
  type: ts.Type,
  packageName: string,
  symbolNames: ReadonlySet<string>,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const symbols = [type.aliasSymbol, type.getSymbol()];
  return symbols.some((symbol) => {
    const name = symbol?.getName();
    return Boolean(
      name && symbolNames.has(name) && symbolComesFromPackage(symbol, packageName, packageRoots),
    );
  });
}

function isDirectResultType(type: ts.Type, packageRoots: readonly WorkspacePackageRoot[]): boolean {
  if (typeIsPackageType(type, "better-result", new Set(["Err", "Ok", "Result"]), packageRoots)) {
    return true;
  }
  return (
    type.isUnion() &&
    type.types.length > 0 &&
    type.types.every((member) =>
      typeIsPackageType(member, "better-result", new Set(["Err", "Ok"]), packageRoots),
    )
  );
}

function isFallibleResultContract(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (isDirectResultType(type, packageRoots)) return true;
  const symbolName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (
    symbolName !== "Promise" &&
    symbolName !== "AsyncIterable" &&
    symbolName !== "AsyncGenerator"
  ) {
    return baseTypes(type).some((baseType) =>
      isFallibleResultContract(baseType, checker, packageRoots),
    );
  }
  const [valueType] = typeArguments(type, checker);
  return Boolean(valueType && isDirectResultType(valueType, packageRoots));
}

function callReceiver(node: ts.CallExpression): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.expression;
  if (ts.isElementAccessExpression(node.expression)) return node.expression.expression;
  return undefined;
}

function isDefaultLibraryDeclaration(node: ts.Node | undefined): boolean {
  if (!node) return false;
  return /(?:^|\/)lib\.[^/]+\.d\.ts$/u.test(normalizedPath(node.getSourceFile().fileName));
}

function outputIdentityMatches(
  identity: CompatibilitySink,
  signature: ts.Signature | undefined,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (!signature?.declaration) return false;
  switch (identity.kind) {
    case "external":
      return (
        packageForSignature(signature, packageRoots) === identity.package &&
        declarationName(signature.declaration) === identity.exportName
      );
    case "local":
      return identityMatches(identity, nodeIdentity(signature.declaration, workspaceRoot));
  }
}

function isRegisteredFormatterCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const signature = checker.getResolvedSignature(node);
  return workspace.taggedErrorFormatters.some((formatter) =>
    outputIdentityMatches(formatter, signature, workspaceRoot, packageRoots),
  );
}

function bindingElementSource(
  element: ts.BindingElement,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const selectors: Array<
    | { readonly kind: "array"; readonly index: number }
    | { readonly kind: "object"; readonly name: string }
  > = [];
  let current = element;
  while (true) {
    const pattern = current.parent;
    if (ts.isObjectBindingPattern(pattern)) {
      const name = current.propertyName ?? current.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) {
        return undefined;
      }
      selectors.unshift({ kind: "object", name: name.text });
    } else if (ts.isArrayBindingPattern(pattern)) {
      const index = pattern.elements.indexOf(current);
      if (index < 0) return undefined;
      selectors.unshift({ kind: "array", index });
    } else {
      return undefined;
    }

    if (!ts.isBindingElement(pattern.parent)) {
      if (!ts.isVariableDeclaration(pattern.parent) || !pattern.parent.initializer)
        return undefined;
      let source: ts.Expression = pattern.parent.initializer;
      const expandedSymbols = new Set<ts.Symbol>();
      for (const selector of selectors) {
        while (ts.isIdentifier(source)) {
          const sourceSymbol = checker.getSymbolAtLocation(source);
          if (!sourceSymbol || expandedSymbols.has(sourceSymbol)) break;
          expandedSymbols.add(sourceSymbol);
          const declaration = sourceSymbol.declarations?.find(
            (candidate): candidate is ts.VariableDeclaration =>
              ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
          );
          if (!declaration?.initializer) break;
          source = declaration.initializer;
        }
        if (selector.kind === "object" && ts.isObjectLiteralExpression(source)) {
          const property = source.properties.find((candidate) => {
            if (
              !ts.isPropertyAssignment(candidate) &&
              !ts.isShorthandPropertyAssignment(candidate)
            ) {
              return false;
            }
            const propertyName = candidate.name;
            return (
              (ts.isIdentifier(propertyName) ||
                ts.isStringLiteral(propertyName) ||
                ts.isNumericLiteral(propertyName)) &&
              propertyName.text === selector.name
            );
          });
          if (property && ts.isPropertyAssignment(property)) {
            source = property.initializer;
            continue;
          }
          if (property && ts.isShorthandPropertyAssignment(property)) {
            source = property.name;
            continue;
          }
          return source;
        }
        if (selector.kind === "array" && ts.isArrayLiteralExpression(source)) {
          const selected = source.elements[selector.index];
          if (!selected || ts.isOmittedExpression(selected) || ts.isSpreadElement(selected)) {
            return source;
          }
          source = selected;
          continue;
        }
        return source;
      }
      return source;
    }
    current = pattern.parent;
  }
}

function latestSymbolSource(
  symbol: ts.Symbol,
  use: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  let latest: { readonly position: number; readonly expression: ts.Expression } | undefined;
  for (const declaration of symbol.declarations ?? []) {
    let expression: ts.Expression | undefined;
    if (ts.isVariableDeclaration(declaration)) expression = declaration.initializer;
    if (ts.isBindingElement(declaration)) expression = bindingElementSource(declaration, checker);
    if (expression && declaration.getStart() < use.getStart()) {
      latest = { position: declaration.getStart(), expression };
    }
  }
  const sourceFile = use.getSourceFile();
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) >= use.getStart()) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      checker.getSymbolAtLocation(node.left) === symbol &&
      (!latest || node.getStart(sourceFile) > latest.position)
    ) {
      latest = { position: node.getStart(sourceFile), expression: node.right };
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return latest?.expression;
}

function expressionContainsUnformattedTaggedError(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const visit = (node: ts.Node): boolean => {
    if (
      ts.isCallExpression(node) &&
      isRegisteredFormatterCall(node, checker, workspace, workspaceRoot, packageRoots)
    ) {
      return false;
    }
    if (ts.isExpression(node)) {
      const type = checker.getTypeAtLocation(node);
      if (
        typeIsTaggedError(type, packageRoots) ||
        (!typeContainsResult(type, checker, packageRoots, node) &&
          typeContainsTaggedError(type, checker, packageRoots, node))
      ) {
        return true;
      }
    }
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (symbol && !seenSymbols.has(symbol)) {
        seenSymbols.add(symbol);
        const source = latestSymbolSource(symbol, node, checker);
        if (source && visit(source)) return true;
      }
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && visit(child)) found = true;
    });
    return found;
  };
  return visit(expression);
}

function makeDiagnostic(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  rule: ArchitectureRule,
  node: ts.Node,
  message: string,
  suggestion: string,
): ArchitectureDiagnostic {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const identity = nodeIdentity(node, workspaceRoot);
  const fingerprintInput = {
    workspace: workspace.name,
    rule,
    module: identity.module,
    symbolPath: identity.symbolPath,
    node,
  } as const;
  return {
    rule,
    severity: "error",
    workspace: workspace.name,
    message,
    suggestion,
    identity: createFingerprintIdentity(fingerprintInput),
    fingerprint: createFingerprint(fingerprintInput),
    location: {
      file: relativeModulePath(workspaceRoot, sourceFile),
      line: start.line + 1,
      column: start.character + 1,
    },
  };
}

function analyzeCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  activeRules: ReadonlySet<ArchitectureRule>,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const signature = checker.getResolvedSignature(node);
  const sourcePackage = packageForSignature(signature, packageRoots);
  const member = declarationName(signature?.declaration);

  if (
    activeRules.has("architecture/no-unregistered-decoder") &&
    sourcePackage === "zod" &&
    member &&
    ZOD_PARSE_MEMBERS.has(member)
  ) {
    const identity = nodeIdentity(node, workspaceRoot);
    if (!workspace.boundaryDecoders.some((decoder) => identityOwns(decoder.identity, identity))) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/no-unregistered-decoder",
          node,
          `Zod ${member} is owned by unregistered symbol ${identity.symbolPath}.`,
          "Move validation to a registered boundary decoder, projection, or persistence codec.",
        ),
      );
    }
  }

  if (
    activeRules.has("architecture/no-production-unwrap") &&
    sourcePackage === "better-result" &&
    member &&
    UNSAFE_RESULT_MEMBERS.has(member)
  ) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-production-unwrap",
        node,
        `better-result ${member} performs unsafe Result extraction.`,
        "Branch on result.status, compose with Result.gen, or map at the owning policy boundary.",
      ),
    );
  }

  if (
    activeRules.has("architecture/no-unmapped-result-capture") &&
    sourcePackage === "better-result" &&
    member &&
    RESULT_CAPTURE_MEMBERS.has(member) &&
    typeContainsUnhandledException(checker.getTypeAtLocation(node), checker, packageRoots, node)
  ) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-unmapped-result-capture",
        node,
        `Result.${member} exposes UnhandledException.`,
        "Use the object overload and map the caught cause to a specific domain-owned error.",
      ),
    );
  }

  if (
    activeRules.has("architecture/registered-panic-site") &&
    sourcePackage === "better-result" &&
    member === "panic"
  ) {
    const finding = makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/registered-panic-site",
      node,
      "Panic callsite is not registered as a hard invariant.",
      "Register this exact fingerprint with an invariant reason, or return a typed expected error.",
    );
    if (!workspace.panicSites.some((site) => site.fingerprint === finding.fingerprint)) {
      diagnostics.push(finding);
    }
  }

  if (activeRules.has("architecture/no-result-wire-leak")) {
    const intrinsicStringify =
      member === "stringify" && isDefaultLibraryDeclaration(signature?.declaration);
    const serialized = node.arguments[0];
    if (
      intrinsicStringify &&
      serialized &&
      typeContainsResult(checker.getTypeAtLocation(serialized), checker, packageRoots, serialized)
    ) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/no-result-wire-leak",
          serialized,
          "JSON.stringify would serialize a Result object instead of an existing wire representation.",
          "Branch on result.status and serialize an explicit compatibility payload.",
        ),
      );
    }
    const output = workspace.compatibilityOutputs.find((candidate) =>
      outputIdentityMatches(candidate.sink, signature, workspaceRoot, packageRoots),
    );
    if (output) {
      for (const argument of node.arguments) {
        if (
          !typeContainsBetterResult(
            checker.getTypeAtLocation(argument),
            checker,
            packageRoots,
            argument,
          )
        )
          continue;
        diagnostics.push(
          makeDiagnostic(
            workspace,
            workspaceRoot,
            "architecture/no-result-wire-leak",
            argument,
            `better-result value is passed directly to registered ${output.category} output ${output.sink.exportName}.`,
            "Map Result or TaggedError to the existing wire representation before crossing this boundary.",
          ),
        );
      }
    }
  }

  if (activeRules.has("architecture/no-unredacted-tagged-error-log")) {
    const receiver = callReceiver(node);
    const intrinsicStringify =
      member === "stringify" && isDefaultLibraryDeclaration(signature?.declaration);
    if (intrinsicStringify) {
      const value = node.arguments[0];
      if (
        value &&
        expressionContainsUnformattedTaggedError(
          value,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
        )
      ) {
        diagnostics.push(
          makeDiagnostic(
            workspace,
            workspaceRoot,
            "architecture/no-unredacted-tagged-error-log",
            value,
            "JSON.stringify receives data manually derived from a TaggedError and may expose its cause or message.",
            "Pass the redacting formatter formatTaggedErrorForLog(error) output to JSON.stringify instead.",
          ),
        );
      }
    } else if (
      member === "toJSON" &&
      receiver &&
      typeContainsTaggedError(checker.getTypeAtLocation(receiver), checker, packageRoots, receiver)
    ) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/no-unredacted-tagged-error-log",
          node,
          "Direct TaggedError.toJSON() exposes the external cause.",
          "Use the approved redacting TaggedError formatter and log only its safe fields.",
        ),
      );
    }

    const logger = workspace.structuredLoggers.find((candidate) =>
      outputIdentityMatches(candidate.sink, signature, workspaceRoot, packageRoots),
    );
    if (logger) {
      for (const argument of node.arguments) {
        if (
          !expressionContainsUnformattedTaggedError(
            argument,
            checker,
            workspace,
            workspaceRoot,
            packageRoots,
          )
        ) {
          continue;
        }
        diagnostics.push(
          makeDiagnostic(
            workspace,
            workspaceRoot,
            "architecture/no-unredacted-tagged-error-log",
            argument,
            `TaggedError is passed directly to structured logger ${logger.sink.exportName}.`,
            "Pass the redacting formatter formatTaggedErrorForLog(error) output and omit manual TaggedError fields.",
          ),
        );
      }
    }
  }
}

function canonicalSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function exportedSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlySet<ts.Symbol> {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return new Set();
  return new Set(
    checker.getExportsOfModule(moduleSymbol).map((symbol) => canonicalSymbol(symbol, checker)),
  );
}

function contractOwnerSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent)
  ) {
    return checker.getSymbolAtLocation(node.parent.name);
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node)
  ) {
    const owner = node.parent;
    if (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) {
      return owner.name && checker.getSymbolAtLocation(owner.name);
    }
  }
  if (ts.isFunctionTypeNode(node)) {
    let owner: ts.Node | undefined = node.parent;
    while (owner && !ts.isTypeAliasDeclaration(owner)) owner = owner.parent;
    if (owner && ts.isTypeAliasDeclaration(owner)) return checker.getSymbolAtLocation(owner.name);
  }
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)) &&
    node.name
  ) {
    return checker.getSymbolAtLocation(node.name);
  }
  return undefined;
}

function isExportedContract(
  node: ts.Node,
  checker: ts.TypeChecker,
  exports: ReadonlySet<ts.Symbol>,
): boolean {
  const symbol = contractOwnerSymbol(node, checker);
  return Boolean(symbol && exports.has(canonicalSymbol(symbol, checker)));
}

function analyzeResultContract(
  node: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  activeRules: ReadonlySet<ArchitectureRule>,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
  exports: ReadonlySet<ts.Symbol>,
): void {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return;
  const returnType = checker.getReturnTypeOfSignature(signature);
  const identity = nodeIdentity(node, workspaceRoot);
  const key = `${identity.module}#${identity.symbolPath}`;

  if (
    activeRules.has("architecture/no-unhandled-exception-contract") &&
    (isExportedContract(node, checker, exports) ||
      workspace.operationalResultApis.some((api) => identityMatches(api, identity))) &&
    typeContainsUnhandledException(returnType, checker, packageRoots, node) &&
    !reported.has(`unhandled:${key}`)
  ) {
    reported.add(`unhandled:${key}`);
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-unhandled-exception-contract",
        node,
        `API ${identity.symbolPath} exposes better-result UnhandledException in its return contract.`,
        "Use mapped Result.try/Result.tryPromise capture and return a specific domain-owned error.",
      ),
    );
  }

  if (
    activeRules.has("architecture/fallible-api-result") &&
    workspace.operationalResultApis.some((api) => identityMatches(api, identity)) &&
    !ts.isFunctionTypeNode(node) &&
    !isFallibleResultContract(returnType, checker, packageRoots) &&
    !reported.has(`fallible:${key}`)
  ) {
    reported.add(`fallible:${key}`);
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/fallible-api-result",
        node,
        `Registered fallible API ${identity.symbolPath} does not return Result, Promise<Result>, or AsyncIterable<Result>.`,
        "Return a typed Result value; asynchronous APIs should resolve Promise<Result<T, E>> rather than reject.",
      ),
    );
  }
}

function analyzeDeclaredResultContract(
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
): void {
  if (
    ts.isTypeAliasDeclaration(node) &&
    (ts.isFunctionTypeNode(node.type) ||
      (ts.isTypeLiteralNode(node.type) &&
        node.type.members.some((member) => ts.isCallSignatureDeclaration(member))))
  ) {
    return;
  }
  const type = checker.getTypeAtLocation(node.name);
  if (!typeContainsUnhandledException(type, checker, packageRoots, node)) return;
  const identity = nodeIdentity(node, workspaceRoot);
  const key = `unhandled:${identity.module}#${identity.symbolPath}`;
  if (reported.has(key)) return;
  reported.add(key);
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-unhandled-exception-contract",
      node,
      `Declared contract ${identity.symbolPath} exposes better-result UnhandledException.`,
      "Replace it with a specific domain-owned error type produced by mapped external capture.",
    ),
  );
}

function analyzeParameter(
  node: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  diagnostics: ArchitectureDiagnostic[],
): void {
  if (!isUnknown(checker.getTypeAtLocation(node))) return;
  const identity = nodeIdentity(node, workspaceRoot);
  if (workspace.boundaryDecoders.some((decoder) => identityOwns(decoder.identity, identity)))
    return;
  if (
    workspace.capabilityPredicates.some((predicate) =>
      identityMatches(predicate.identity, identity),
    )
  )
    return;
  if (
    workspace.exceptionAdapters.some(
      (adapter) =>
        adapter.direction !== "signal-host" && identityMatches(adapter.identity, identity),
    )
  ) {
    return;
  }
  const contractIdentity = parameterContractIdentity(node, workspaceRoot);
  if (
    workspace.opaqueUnknown.some(
      (exception) =>
        identityMatches(exception.identity, identity) ||
        (contractIdentity !== undefined && identityMatches(exception.identity, contractIdentity)),
    )
  )
    return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-domain-unknown",
      node,
      `Internal parameter ${node.name.getText()} carries domain data as unknown.`,
      "Decode at the external boundary and type this internal parameter with the decoded domain type.",
    ),
  );
}

function analyzeAssertion(
  node: ts.AsExpression | ts.TypeAssertion,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  diagnostics: ArchitectureDiagnostic[],
): void {
  if (!isUnknown(checker.getTypeAtLocation(node.expression))) return;
  if (!isStructured(checker.getTypeFromTypeNode(node.type))) return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-unknown-assertion",
      node,
      "Structured domain type is asserted directly from unknown.",
      "Use a registered complete decoder and pass its typed output to domain code.",
    ),
  );
}

function analyzePredicate(
  node: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
): void {
  if (!node.type || !ts.isTypePredicateNode(node.type)) return;
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return;
  const predicate = checker.getTypePredicateOfSignature(signature);
  if (!predicate?.type || predicate.parameterIndex === undefined) return;
  const parameter = node.parameters[predicate.parameterIndex];
  if (
    !parameter ||
    !isUnknown(checker.getTypeAtLocation(parameter)) ||
    !isStructured(predicate.type)
  )
    return;

  const identity = nodeIdentity(node, workspaceRoot);
  if (
    workspace.capabilityPredicates.some((exception) =>
      identityMatches(exception.identity, identity),
    )
  )
    return;
  const key = `${identity.module}#${identity.symbolPath}`;
  if (reported.has(key)) return;
  reported.add(key);
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-rich-unknown-predicate",
      node,
      `Predicate ${identity.symbolPath} promises a structured type from unknown.`,
      "Replace it with a complete boundary schema decoder or register a narrow exact capability check.",
    ),
  );
}

interface LiteralDomain {
  readonly keys: ReadonlyMap<string, string>;
}

function isProjectDeclaration(
  declaration: ts.Node,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const sourceFile = declaration.getSourceFile();
  if (sourceFile.isDeclarationFile) return false;
  const file = canonicalPath(sourceFile.fileName);
  return packageRoots.some((candidate) => {
    const root = canonicalPath(candidate.root);
    return file === root || file.startsWith(`${root}/`);
  });
}

function typeNodeIsProjectOwned(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol>,
): boolean {
  if (ts.isLiteralTypeNode(node) || ts.isTypeLiteralNode(node)) return true;
  if (ts.isParenthesizedTypeNode(node)) {
    return typeNodeIsProjectOwned(node.type, checker, packageRoots, seenSymbols);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.every((member) =>
      typeNodeIsProjectOwned(member, checker, packageRoots, seenSymbols),
    );
  }
  if (ts.isTypeReferenceNode(node)) {
    const referenced = checker.getSymbolAtLocation(node.typeName);
    if (!referenced) return false;
    const symbol = canonicalSymbol(referenced, checker);
    if (seenSymbols.has(symbol)) return true;
    seenSymbols.add(symbol);
    const declarations = symbol.declarations ?? [];
    if (
      declarations.length === 0 ||
      declarations.some((declaration) => !isProjectDeclaration(declaration, packageRoots))
    ) {
      return false;
    }
    return declarations.every((declaration) => {
      if (ts.isTypeAliasDeclaration(declaration)) {
        return typeNodeIsProjectOwned(declaration.type, checker, packageRoots, seenSymbols);
      }
      if (ts.isTypeParameterDeclaration(declaration)) {
        return Boolean(
          declaration.constraint &&
          typeNodeIsProjectOwned(declaration.constraint, checker, packageRoots, seenSymbols),
        );
      }
      return true;
    });
  }
  return false;
}

function typeIsProjectOwned(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenTypes: Set<ts.Type> = new Set(),
): boolean {
  if (seenTypes.has(type)) return true;
  seenTypes.add(type);
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const declarations = type.getSymbol()?.declarations ?? [];
    if (
      declarations.some((declaration) => {
        if (!ts.isTypeParameterDeclaration(declaration) || !declaration.constraint) return false;
        return (
          isProjectDeclaration(declaration, packageRoots) &&
          typeNodeIsProjectOwned(declaration.constraint, checker, packageRoots, new Set())
        );
      })
    ) {
      return true;
    }
    const constraint = checker.getBaseConstraintOfType(type);
    return Boolean(constraint && typeIsProjectOwned(constraint, checker, packageRoots, seenTypes));
  }
  const alias = type.aliasSymbol;
  if (alias) {
    const declarations = alias.declarations ?? [];
    return (
      declarations.length > 0 &&
      declarations.every(
        (declaration) =>
          isProjectDeclaration(declaration, packageRoots) &&
          (!ts.isTypeAliasDeclaration(declaration) ||
            typeNodeIsProjectOwned(declaration.type, checker, packageRoots, new Set([alias]))),
      )
    );
  }
  if (type.isUnionOrIntersection()) {
    return type.types.every((member) =>
      typeIsProjectOwned(member, checker, packageRoots, seenTypes),
    );
  }
  const symbol = type.getSymbol();
  const declarations = symbol?.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => isProjectDeclaration(declaration, packageRoots))
  );
}

function literalKey(type: ts.Type, checker: ts.TypeChecker): readonly [string, string] | undefined {
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    const value = (type as ts.StringLiteralType).value;
    return [`string:${value}`, JSON.stringify(value)];
  }
  if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
    const value = (type as ts.NumberLiteralType).value;
    return [`number:${value}`, String(value)];
  }
  if ((type.flags & ts.TypeFlags.EnumLiteral) !== 0) {
    const value = checker.typeToString(type);
    return [`enum:${value}`, value];
  }
  return undefined;
}

function literalDomain(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  ownershipType: ts.Type = type,
  ownershipConfirmed = false,
): LiteralDomain | undefined {
  let resolved = type;
  if ((resolved.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(resolved);
    if (!constraint) return undefined;
    resolved = constraint;
  }
  const members = resolved.isUnion() ? resolved.types : [resolved];
  if (
    members.length < 2 ||
    (!ownershipConfirmed && !typeIsProjectOwned(ownershipType, checker, packageRoots))
  ) {
    return undefined;
  }
  const keys = new Map<string, string>();
  for (const member of members) {
    const key = literalKey(member, checker);
    if (!key) return undefined;
    keys.set(key[0], key[1]);
  }
  return keys.size < 2 ? undefined : { keys };
}

function declaredTypeNode(node: ts.Declaration): ts.TypeNode | undefined {
  if (
    ts.isParameter(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node)
  ) {
    return node.type;
  }
  return undefined;
}

function expressionTypeIsProjectOwned(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const type = checker.getTypeAtLocation(expression);
  if (typeIsProjectOwned(type, checker, packageRoots)) return true;
  if (ts.isCallExpression(expression)) {
    return expressionInfersLiteralUnion(expression, checker, packageRoots, new Set());
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const property = checker.getSymbolAtLocation(expression.name);
    const declarations = property?.declarations ?? [];
    const declaredOwned =
      declarations.length > 0 &&
      declarations.every((declaration) => {
        const typeNode = declaredTypeNode(declaration);
        return Boolean(
          typeNode &&
          isProjectDeclaration(declaration, packageRoots) &&
          typeNodeIsProjectOwned(typeNode, checker, packageRoots, new Set()),
        );
      });
    return (
      declaredOwned ||
      expressionInfersObjectDiscriminant(
        expression.expression,
        expression.name.text,
        checker,
        packageRoots,
        new Set(),
      )
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (!argument || !ts.isStringLiteralLike(argument)) return false;
    const property = checker.getTypeAtLocation(expression.expression).getProperty(argument.text);
    const declarations = property?.declarations ?? [];
    const declaredOwned =
      declarations.length > 0 &&
      declarations.every((declaration) => {
        const typeNode = declaredTypeNode(declaration);
        return Boolean(
          typeNode &&
          isProjectDeclaration(declaration, packageRoots) &&
          typeNodeIsProjectOwned(typeNode, checker, packageRoots, new Set()),
        );
      });
    return (
      declaredOwned ||
      expressionInfersObjectDiscriminant(
        expression.expression,
        argument.text,
        checker,
        packageRoots,
        new Set(),
      )
    );
  }
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  return (
    symbol?.declarations?.some((declaration) => {
      const typeNode = declaredTypeNode(declaration);
      if (
        typeNode &&
        isProjectDeclaration(declaration, packageRoots) &&
        typeNodeIsProjectOwned(typeNode, checker, packageRoots, new Set())
      ) {
        return true;
      }
      return (
        ts.isVariableDeclaration(declaration) &&
        Boolean(declaration.initializer) &&
        isProjectDeclaration(declaration, packageRoots) &&
        expressionInfersLiteralUnion(
          declaration.initializer as ts.Expression,
          checker,
          packageRoots,
          new Set(),
        )
      );
    }) ?? false
  );
}

function expressionInfersLiteralUnion(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteralLike(unwrapped) || ts.isNumericLiteral(unwrapped)) return true;
  if (ts.isConditionalExpression(unwrapped)) {
    return (
      expressionInfersLiteralUnion(
        unwrapped.whenTrue,
        checker,
        packageRoots,
        new Set(seenSymbols),
      ) &&
      expressionInfersLiteralUnion(unwrapped.whenFalse, checker, packageRoots, new Set(seenSymbols))
    );
  }
  if (ts.isCallExpression(unwrapped)) {
    const declaration = checker.getResolvedSignature(unwrapped)?.declaration;
    return Boolean(
      declaration &&
      isProjectDeclaration(declaration, packageRoots) &&
      functionReturnExpressions(declaration).every((returned) =>
        expressionInfersLiteralUnion(returned, checker, packageRoots, new Set(seenSymbols)),
      ) &&
      functionReturnExpressions(declaration).length > 0,
    );
  }
  if (!ts.isIdentifier(unwrapped)) return false;
  const symbol = ts.isShorthandPropertyAssignment(unwrapped.parent)
    ? checker.getShorthandAssignmentValueSymbol(unwrapped.parent)
    : checker.getSymbolAtLocation(unwrapped);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  return (
    symbol.declarations?.some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        Boolean(declaration.initializer) &&
        expressionInfersLiteralUnion(
          declaration.initializer as ts.Expression,
          checker,
          packageRoots,
          new Set(seenSymbols),
        ),
    ) ?? false
  );
}

function functionReturnExpressions(
  node: ts.SignatureDeclaration | ts.JSDocSignature,
): readonly ts.Expression[] {
  const body =
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
      ? node.body
      : undefined;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const returned: ts.Expression[] = [];
  const visit = (child: ts.Node): void => {
    if (child !== body && ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child) && child.expression) {
      returned.push(child.expression);
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(body);
  return returned;
}

function expressionInfersObjectDiscriminant(
  expression: ts.Expression,
  propertyName: string,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const property = unwrapped.properties.find(
      (candidate) =>
        (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
        (ts.isIdentifier(candidate.name) || ts.isStringLiteralLike(candidate.name)) &&
        candidate.name.text === propertyName,
    );
    let initializer: ts.Expression | undefined;
    if (property && ts.isPropertyAssignment(property)) initializer = property.initializer;
    if (property && ts.isShorthandPropertyAssignment(property)) initializer = property.name;
    return Boolean(
      initializer &&
      expressionInfersLiteralUnion(initializer, checker, packageRoots, new Set(seenSymbols)),
    );
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return (
      expressionInfersObjectDiscriminant(
        unwrapped.whenTrue,
        propertyName,
        checker,
        packageRoots,
        new Set(seenSymbols),
      ) &&
      expressionInfersObjectDiscriminant(
        unwrapped.whenFalse,
        propertyName,
        checker,
        packageRoots,
        new Set(seenSymbols),
      )
    );
  }
  if (ts.isCallExpression(unwrapped)) {
    const declaration = checker.getResolvedSignature(unwrapped)?.declaration;
    if (!declaration || !isProjectDeclaration(declaration, packageRoots)) return false;
    const returned = functionReturnExpressions(declaration);
    return (
      returned.length > 0 &&
      returned.every((value) =>
        expressionInfersObjectDiscriminant(
          value,
          propertyName,
          checker,
          packageRoots,
          new Set(seenSymbols),
        ),
      )
    );
  }
  if (!ts.isIdentifier(unwrapped)) return false;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  return (
    symbol.declarations?.some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        Boolean(declaration.initializer) &&
        expressionInfersObjectDiscriminant(
          declaration.initializer as ts.Expression,
          propertyName,
          checker,
          packageRoots,
          new Set(seenSymbols),
        ),
    ) ?? false
  );
}

function switchDomain(
  node: ts.SwitchStatement,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): LiteralDomain | undefined {
  const direct = literalDomain(
    checker.getTypeAtLocation(node.expression),
    checker,
    packageRoots,
    checker.getTypeAtLocation(node.expression),
    expressionTypeIsProjectOwned(node.expression, checker, packageRoots),
  );
  if (direct) return direct;
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  return symbol && canonicalSymbol(symbol, checker);
}

function switchSourceExpressions(expression: ts.Expression): readonly ts.Expression[] {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return [unwrapped, unwrapExpression(unwrapped.expression)];
  }
  return [unwrapped];
}

function selectedProperty(
  expression: ts.Expression,
): { readonly receiver: ts.Expression; readonly name: string } | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return { receiver: unwrapped.expression, name: unwrapped.name.text };
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    unwrapped.argumentExpression &&
    ts.isStringLiteralLike(unwrapped.argumentExpression)
  ) {
    return { receiver: unwrapped.expression, name: unwrapped.argumentExpression.text };
  }
  return undefined;
}

function expressionDerivesFromSwitch(
  expression: ts.Expression,
  switched: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const unwrapped = unwrapExpression(expression);
  for (const source of switchSourceExpressions(switched)) {
    if (unwrapped === source) return true;
    const expressionOwner = expressionSymbol(unwrapped, checker);
    const sourceOwner = expressionSymbol(source, checker);
    if (expressionOwner && sourceOwner && expressionOwner === sourceOwner) return true;
    const expressionProperty = selectedProperty(unwrapped);
    const sourceProperty = selectedProperty(source);
    if (expressionProperty && sourceProperty && expressionProperty.name === sourceProperty.name) {
      const expressionReceiver = expressionSymbol(expressionProperty.receiver, checker);
      const sourceReceiver = expressionSymbol(sourceProperty.receiver, checker);
      if (expressionReceiver && sourceReceiver && expressionReceiver === sourceReceiver)
        return true;
    }
  }
  if (!ts.isIdentifier(unwrapped)) return false;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  return (
    symbol.declarations?.some((declaration) => {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return expressionDerivesFromSwitch(declaration.initializer, switched, checker, seenSymbols);
      }
      if (ts.isBindingElement(declaration)) {
        const source = bindingElementSource(declaration, checker);
        return Boolean(
          source && expressionDerivesFromSwitch(source, switched, checker, seenSymbols),
        );
      }
      return false;
    }) ?? false
  );
}

function defaultContainsNeverSink(
  clause: ts.DefaultClause,
  switched: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      for (const [index, argument] of node.arguments.entries()) {
        const parameter = signature?.parameters[Math.min(index, signature.parameters.length - 1)];
        if (!parameter) continue;
        const parameterType = checker.getTypeOfSymbolAtLocation(parameter, argument);
        const argumentType = checker.getTypeAtLocation(argument);
        if (
          (parameterType.flags & ts.TypeFlags.Never) !== 0 &&
          (argumentType.flags & ts.TypeFlags.Never) !== 0 &&
          expressionDerivesFromSwitch(argument, switched, checker)
        ) {
          found = true;
          return;
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      node.initializer &&
      (checker.getTypeFromTypeNode(node.type).flags & ts.TypeFlags.Never) !== 0 &&
      (checker.getTypeAtLocation(node.initializer).flags & ts.TypeFlags.Never) !== 0 &&
      expressionDerivesFromSwitch(node.initializer, switched, checker)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(clause);
  return found;
}

function analyzeClosedUnionSwitch(
  node: ts.SwitchStatement,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const domain = switchDomain(node, checker, packageRoots);
  if (!domain) return;
  const handled = new Set<string>();
  let defaultClause: ts.DefaultClause | undefined;
  for (const clause of node.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      defaultClause = clause;
      continue;
    }
    const caseDomain = literalDomain(
      checker.getTypeAtLocation(clause.expression),
      checker,
      packageRoots,
    );
    if (caseDomain) {
      for (const key of caseDomain.keys.keys()) handled.add(key);
      continue;
    }
    const key = literalKey(checker.getTypeAtLocation(clause.expression), checker);
    if (key) handled.add(key[0]);
  }
  const missing = [...domain.keys]
    .filter(([key]) => !handled.has(key))
    .map(([, display]) => display);
  const silentDefault =
    defaultClause && !defaultContainsNeverSink(defaultClause, node.expression, checker);
  if (missing.length === 0 && !silentDefault) return;
  const detail = missing.length
    ? `missing ${missing.join(", ")}`
    : "uses a silent default after handling every known member";
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/closed-union-exhaustiveness",
      defaultClause ?? node,
      `Switch over a project-owned closed union is not exhaustive: ${detail}.`,
      "Handle every union member directly; omit default, or use a default that passes the narrowed value to a never sink.",
    ),
  );
}

interface MapResolution {
  readonly object: ts.ObjectLiteralExpression;
  readonly checkedTypeNodes: readonly ts.TypeNode[];
  readonly assertedTypeNodes: readonly ts.TypeNode[];
}

function mapResolutionFromExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): MapResolution | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return mapResolutionFromExpression(expression.expression, checker, seenSymbols);
  }
  if (ts.isSatisfiesExpression(expression)) {
    const resolution = mapResolutionFromExpression(expression.expression, checker, seenSymbols);
    return resolution
      ? {
          ...resolution,
          checkedTypeNodes: [...resolution.checkedTypeNodes, expression.type],
        }
      : undefined;
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    const resolution = mapResolutionFromExpression(expression.expression, checker, seenSymbols);
    return resolution
      ? {
          ...resolution,
          assertedTypeNodes: [...resolution.assertedTypeNodes, expression.type],
        }
      : undefined;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return { object: expression, checkedTypeNodes: [], assertedTypeNodes: [] };
  }
  const located = ts.isIdentifier(expression)
    ? checker.getSymbolAtLocation(expression)
    : ts.isPropertyAccessExpression(expression)
      ? checker.getSymbolAtLocation(expression.name)
      : ts.isElementAccessExpression(expression) &&
          expression.argumentExpression &&
          ts.isStringLiteralLike(expression.argumentExpression)
        ? checker.getSymbolAtLocation(expression.argumentExpression)
        : undefined;
  if (!located) return undefined;
  const symbol = canonicalSymbol(located, checker);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  const declaration = symbol.declarations?.find(
    (
      candidate,
    ): candidate is ts.VariableDeclaration | ts.PropertyDeclaration | ts.PropertyAssignment =>
      (ts.isVariableDeclaration(candidate) ||
        ts.isPropertyDeclaration(candidate) ||
        ts.isPropertyAssignment(candidate)) &&
      candidate.initializer !== undefined,
  );
  if (!declaration?.initializer) return undefined;
  const resolution = mapResolutionFromExpression(declaration.initializer, checker, seenSymbols);
  if (!resolution || ts.isPropertyAssignment(declaration) || !declaration.type) return resolution;
  return {
    ...resolution,
    checkedTypeNodes: [...resolution.checkedTypeNodes, declaration.type],
  };
}

function domainsInTypeNode(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): readonly LiteralDomain[] {
  const domains: LiteralDomain[] = [];
  const seenAliases = new Set<ts.Symbol>();
  const visit = (child: ts.Node): void => {
    if (ts.isTypeNode(child)) {
      const domain = literalDomain(checker.getTypeFromTypeNode(child), checker, packageRoots);
      const ownedDomain =
        domain ??
        literalDomain(
          checker.getTypeFromTypeNode(child),
          checker,
          packageRoots,
          checker.getTypeFromTypeNode(child),
          isProjectDeclaration(child, packageRoots) &&
            typeNodeIsProjectOwned(child, checker, packageRoots, new Set()),
        );
      if (ownedDomain) domains.push(ownedDomain);
      if (ts.isTypeReferenceNode(child)) {
        const located = checker.getSymbolAtLocation(child.typeName);
        const symbol = located && canonicalSymbol(located, checker);
        if (symbol && !seenAliases.has(symbol)) {
          seenAliases.add(symbol);
          for (const declaration of symbol.declarations ?? []) {
            if (ts.isTypeAliasDeclaration(declaration)) visit(declaration.type);
          }
        }
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return domains;
}

function typeNodeHasDomainProperties(
  typeNode: ts.TypeNode,
  domain: LiteralDomain,
  checker: ts.TypeChecker,
): boolean {
  const contract = checker.getTypeFromTypeNode(typeNode);
  return [...domain.keys.keys()].every((key) => {
    const name = propertyNameForLiteralKey(key);
    return name !== undefined && checker.getPropertyOfType(contract, name) !== undefined;
  });
}

function typeNodeIsMapContract(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenAliases: Set<ts.Symbol> = new Set(),
): boolean {
  if (ts.isMappedTypeNode(node)) return true;
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) {
    return typeNodeIsMapContract(node.type, checker, packageRoots, seenAliases);
  }
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
    return node.types.some((type) =>
      typeNodeIsMapContract(type, checker, packageRoots, seenAliases),
    );
  }
  if (!ts.isTypeReferenceNode(node)) return false;
  const referenceName = ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;
  if (referenceName === "Record") return true;
  if (
    node.typeArguments?.some((type) =>
      typeNodeIsMapContract(type, checker, packageRoots, seenAliases),
    )
  ) {
    return true;
  }
  const located = checker.getSymbolAtLocation(node.typeName);
  const symbol = located && canonicalSymbol(located, checker);
  if (!symbol || seenAliases.has(symbol)) return false;
  seenAliases.add(symbol);
  return (
    symbol.declarations?.some(
      (declaration) =>
        ts.isTypeAliasDeclaration(declaration) &&
        isProjectDeclaration(declaration, packageRoots) &&
        typeNodeIsMapContract(declaration.type, checker, packageRoots, seenAliases),
    ) ?? false
  );
}

function propertyNameForLiteralKey(key: string): string | undefined {
  const separator = key.indexOf(":");
  if (separator < 0) return undefined;
  return key.slice(separator + 1);
}

function typeNodeRequiresDomain(
  typeNode: ts.TypeNode,
  domain: LiteralDomain,
  checker: ts.TypeChecker,
): boolean {
  const contract = checker.getTypeFromTypeNode(typeNode);
  return [...domain.keys.keys()].every((key) => {
    const name = propertyNameForLiteralKey(key);
    if (name === undefined) return false;
    const property = checker.getPropertyOfType(contract, name);
    return Boolean(property && (property.flags & ts.SymbolFlags.Optional) === 0);
  });
}

function typeNodeMatchesDomain(
  typeNode: ts.TypeNode,
  domain: LiteralDomain,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  return domainsInTypeNode(typeNode, checker, packageRoots).some(
    (candidate) =>
      candidate.keys.size === domain.keys.size &&
      [...candidate.keys.keys()].every((key) => domain.keys.has(key)),
  );
}

function mapIsCompilerChecked(
  resolution: MapResolution,
  domain: LiteralDomain,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (
    resolution.assertedTypeNodes.some((typeNode) =>
      typeNodeMatchesDomain(typeNode, domain, checker, packageRoots),
    )
  ) {
    return false;
  }
  return resolution.checkedTypeNodes.some(
    (typeNode) =>
      typeNodeMatchesDomain(typeNode, domain, checker, packageRoots) &&
      typeNodeRequiresDomain(typeNode, domain, checker),
  );
}

function analyzeClosedUnionMap(
  resolution: MapResolution,
  domain: LiteralDomain,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
): void {
  const object = resolution.object;
  const reportKey = `${canonicalPath(object.getSourceFile().fileName)}:${object.getStart()}`;
  if (reported.has(reportKey) || mapIsCompilerChecked(resolution, domain, checker, packageRoots)) {
    return;
  }
  reported.add(reportKey);
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/closed-union-map-exhaustiveness",
      object,
      "Map keyed by a project-owned closed union is not compiler-checked as exhaustive.",
      "Declare or satisfy a required mapped type such as Record<Union, Value>; do not use Partial, a broad index signature, or a type assertion.",
    ),
  );
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function propertyTypeNodeInContract(
  contract: ts.TypeNode,
  propertyName: string,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): ts.TypeNode | undefined {
  if (ts.isParenthesizedTypeNode(contract) || ts.isTypeOperatorNode(contract)) {
    return propertyTypeNodeInContract(contract.type, propertyName, checker, seenSymbols);
  }
  if (ts.isIntersectionTypeNode(contract) || ts.isUnionTypeNode(contract)) {
    for (const member of contract.types) {
      const selected = propertyTypeNodeInContract(member, propertyName, checker, seenSymbols);
      if (selected) return selected;
    }
    return undefined;
  }
  if (ts.isTypeLiteralNode(contract)) {
    for (const member of contract.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      if (propertyNameText(member.name) === propertyName) return member.type;
    }
    return undefined;
  }
  if (!ts.isTypeReferenceNode(contract)) return undefined;
  const located = checker.getSymbolAtLocation(contract.typeName);
  const symbol = located && canonicalSymbol(located, checker);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isTypeAliasDeclaration(declaration)) {
      const selected = propertyTypeNodeInContract(
        declaration.type,
        propertyName,
        checker,
        seenSymbols,
      );
      if (selected) return selected;
    }
    if (ts.isInterfaceDeclaration(declaration)) {
      for (const member of declaration.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        if (propertyNameText(member.name) === propertyName) return member.type;
      }
    }
  }
  return undefined;
}

interface NestedPropertyContracts {
  readonly asserted: readonly ts.TypeNode[];
  readonly checked: readonly ts.TypeNode[];
}

function selectPropertyContractPath(
  root: ts.TypeNode,
  path: readonly string[],
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  let selected: ts.TypeNode | undefined = root;
  for (const segment of path) {
    selected = propertyTypeNodeInContract(selected, segment, checker);
    if (!selected) return undefined;
  }
  return selected;
}

function nestedPropertyContracts(
  node: ts.PropertyAssignment,
  checker: ts.TypeChecker,
): NestedPropertyContracts {
  const path: string[] = [];
  const asserted: ts.TypeNode[] = [];
  const checked: ts.TypeNode[] = [];
  let property: ts.PropertyAssignment = node;
  while (true) {
    const name = propertyNameText(property.name);
    if (!name) return { asserted, checked };
    path.unshift(name);
    const object = property.parent;
    let expression: ts.Expression = object;
    while (true) {
      const wrapper = expression.parent;
      if (ts.isParenthesizedExpression(wrapper) && wrapper.expression === expression) {
        expression = wrapper;
        continue;
      }
      if (
        (ts.isAsExpression(wrapper) ||
          ts.isSatisfiesExpression(wrapper) ||
          ts.isTypeAssertionExpression(wrapper)) &&
        wrapper.expression === expression
      ) {
        const selected = selectPropertyContractPath(wrapper.type, path, checker);
        if (selected) {
          if (ts.isSatisfiesExpression(wrapper)) checked.push(selected);
          else asserted.push(selected);
        }
        expression = wrapper;
        continue;
      }
      break;
    }
    const owner = expression.parent;
    if (ts.isPropertyAssignment(owner) && owner.initializer === expression) {
      property = owner;
      continue;
    }
    const rootType =
      (ts.isVariableDeclaration(owner) || ts.isPropertyDeclaration(owner)) &&
      owner.initializer === expression
        ? owner.type
        : undefined;
    if (rootType) {
      const selected = selectPropertyContractPath(rootType, path, checker);
      if (selected) checked.push(selected);
    }
    return { asserted, checked };
  }
}

function analyzeDeclaredClosedUnionMap(
  node: ts.VariableDeclaration | ts.PropertyDeclaration | ts.PropertyAssignment,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
): void {
  if (!node.initializer) return;
  const initial = mapResolutionFromExpression(node.initializer, checker);
  if (!initial) return;
  const nestedContracts = ts.isPropertyAssignment(node)
    ? nestedPropertyContracts(node, checker)
    : { asserted: [], checked: node.type ? [node.type] : [] };
  const resolution: MapResolution = {
    ...initial,
    assertedTypeNodes: [...initial.assertedTypeNodes, ...nestedContracts.asserted],
    checkedTypeNodes: [...initial.checkedTypeNodes, ...nestedContracts.checked],
  };
  const contracts = [...resolution.checkedTypeNodes, ...resolution.assertedTypeNodes];
  for (const contract of contracts) {
    if (!typeNodeIsMapContract(contract, checker, packageRoots)) continue;
    for (const domain of domainsInTypeNode(contract, checker, packageRoots)) {
      if (!typeNodeHasDomainProperties(contract, domain, checker)) continue;
      analyzeClosedUnionMap(
        resolution,
        domain,
        checker,
        workspace,
        workspaceRoot,
        packageRoots,
        diagnostics,
        reported,
      );
    }
  }
}

function symbolIsExternalProtocol(
  symbol: ts.Symbol,
  packageName: string,
  exportName: string,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const canonical = canonicalSymbol(symbol, checker);
  return (
    canonical.getName() === exportName &&
    symbolComesFromPackage(canonical, packageName, packageRoots)
  );
}

function typeNodeIsExactExternalProtocol(
  node: ts.TypeNode,
  packageName: string,
  exportName: string,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  if (ts.isParenthesizedTypeNode(node)) {
    return typeNodeIsExactExternalProtocol(
      node.type,
      packageName,
      exportName,
      checker,
      packageRoots,
      seenSymbols,
    );
  }
  if (!ts.isTypeReferenceNode(node) || node.typeArguments?.length) return false;
  const located = checker.getSymbolAtLocation(node.typeName);
  if (!located) return false;
  const symbol = canonicalSymbol(located, checker);
  if (symbolIsExternalProtocol(symbol, packageName, exportName, checker, packageRoots)) return true;
  if (seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  const aliases = symbol.declarations?.filter(ts.isTypeAliasDeclaration) ?? [];
  return (
    aliases.length > 0 &&
    aliases.every(
      (declaration) =>
        isProjectDeclaration(declaration, packageRoots) &&
        typeNodeIsExactExternalProtocol(
          declaration.type,
          packageName,
          exportName,
          checker,
          packageRoots,
          seenSymbols,
        ),
    )
  );
}

function expressionIsExactExternalProtocol(
  expression: ts.Expression,
  packageName: string,
  exportName: string,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const unwrapped = unwrapExpression(expression);
  const type = checker.getTypeAtLocation(unwrapped);
  if (typeIsPackageType(type, packageName, new Set([exportName]), packageRoots)) return true;
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return expressionIsExactExternalProtocol(
      unwrapped.expression,
      packageName,
      exportName,
      checker,
      packageRoots,
      seenSymbols,
    );
  }
  if (!ts.isIdentifier(unwrapped)) return false;
  const located = checker.getSymbolAtLocation(unwrapped);
  if (!located) return false;
  const symbol = canonicalSymbol(located, checker);
  if (seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  return (
    symbol.declarations?.some((declaration) => {
      const typeNode = declaredTypeNode(declaration);
      if (
        typeNode &&
        typeNodeIsExactExternalProtocol(typeNode, packageName, exportName, checker, packageRoots)
      ) {
        return true;
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return expressionIsExactExternalProtocol(
          declaration.initializer,
          packageName,
          exportName,
          checker,
          packageRoots,
          seenSymbols,
        );
      }
      if (ts.isBindingElement(declaration)) {
        const source = bindingElementSource(declaration, checker);
        return Boolean(
          source &&
          expressionIsExactExternalProtocol(
            source,
            packageName,
            exportName,
            checker,
            packageRoots,
            seenSymbols,
          ),
        );
      }
      return false;
    }) ?? false
  );
}

function discriminantValue(
  type: ts.Type,
  discriminant: string,
  checker: ts.TypeChecker,
  location: ts.Node,
): string | undefined {
  const property = checker.getPropertyOfType(type, discriminant);
  if (!property) return undefined;
  const propertyType = checker.getTypeOfSymbolAtLocation(property, location);
  if ((propertyType.flags & ts.TypeFlags.StringLiteral) === 0) return undefined;
  return (propertyType as ts.StringLiteralType).value;
}

function isClosedLocalDiscriminatedUnion(
  type: ts.Type,
  discriminant: string,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  if (
    !type.isUnion() ||
    type.types.length < 2 ||
    !typeIsProjectOwned(type, checker, packageRoots)
  ) {
    return false;
  }
  const values = type.types.map((member) =>
    discriminantValue(member, discriminant, checker, location),
  );
  return values.every((value) => value !== undefined) && new Set(values).size === values.length;
}

function expressionHasFallback(
  expression: ts.Expression,
  discriminant: string,
  fallback: string,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const unwrapped = ts.isParenthesizedExpression(expression)
    ? expression.expression
    : ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression) ||
        ts.isTypeAssertionExpression(expression)
      ? expression.expression
      : expression;
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const property = unwrapped.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
        candidate.name.text === discriminant,
    );
    if (
      property &&
      (ts.isStringLiteral(property.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(property.initializer))
    ) {
      return property.initializer.text === fallback;
    }
  }
  const value = discriminantValue(
    checker.getTypeAtLocation(unwrapped),
    discriminant,
    checker,
    unwrapped,
  );
  if (value === fallback) return true;
  if (!ts.isIdentifier(unwrapped)) return false;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  const declaration = symbol.declarations?.find(
    (candidate): candidate is ts.VariableDeclaration =>
      ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
  );
  return Boolean(
    declaration?.initializer &&
    expressionHasFallback(declaration.initializer, discriminant, fallback, checker, seenSymbols),
  );
}

function functionReturnsFallback(
  node: ts.SignatureDeclaration,
  discriminant: string,
  fallback: string,
  checker: ts.TypeChecker,
): boolean {
  const body =
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
      ? node.body
      : undefined;
  if (!body) return false;
  if (!ts.isBlock(body)) return expressionHasFallback(body, discriminant, fallback, checker);
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (child !== body && ts.isFunctionLike(child)) return;
    if (
      ts.isReturnStatement(child) &&
      child.expression &&
      expressionHasFallback(child.expression, discriminant, fallback, checker)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(body);
  return found;
}

function functionHasImplementation(node: ts.SignatureDeclaration): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.body !== undefined;
  }
  return false;
}

function assertOpenProtocolAdaptersResolve(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
): void {
  for (const adapter of workspace.openProtocolAdapters) {
    const matches: ts.SignatureDeclaration[] = [];
    const sourceFile = program
      .getSourceFiles()
      .find(
        (candidate) =>
          !candidate.isDeclarationFile &&
          relativeModulePath(workspaceRoot, candidate) === adapter.identity.module,
      );
    if (sourceFile) {
      const visit = (node: ts.Node): void => {
        if (
          ts.isFunctionLike(node) &&
          functionHasImplementation(node) &&
          identityMatches(adapter.identity, nodeIdentity(node, workspaceRoot))
        ) {
          matches.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    if (matches.length !== 1) {
      throw new Error(
        `Open-protocol adapter ${workspace.name}/${adapter.identity.module}#${adapter.identity.exportName} must resolve to exactly one callable implementation; found ${matches.length}.`,
      );
    }
  }
}

function analyzeOpenProtocolAdapter(
  node: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const identity = nodeIdentity(node, workspaceRoot);
  const adapter = workspace.openProtocolAdapters.find((candidate) =>
    identityMatches(candidate.identity, identity),
  );
  if (!adapter) return;
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return;
  const parameter = node.parameters[adapter.protocolParameter];
  const inputValid = Boolean(
    parameter &&
    parameter.type &&
    typeNodeIsExactExternalProtocol(
      parameter.type,
      adapter.externalProtocol.package,
      adapter.externalProtocol.exportName,
      checker,
      packageRoots,
    ),
  );
  const returnType = checker.getReturnTypeOfSignature(signature);
  const fallback = adapter.fallbackVariant;
  const outputClosed = isClosedLocalDiscriminatedUnion(
    returnType,
    fallback.discriminant,
    checker,
    packageRoots,
    node,
  );
  const outputHasFallback =
    outputClosed &&
    returnType.isUnion() &&
    returnType.types.some(
      (member) =>
        discriminantValue(member, fallback.discriminant, checker, node) === fallback.value,
    );
  const implementationHasFallback = functionReturnsFallback(
    node,
    fallback.discriminant,
    fallback.value,
    checker,
  );
  if (inputValid && outputHasFallback && implementationHasFallback) return;
  const failures = [
    inputValid ? undefined : "the registered parameter is not the named external protocol",
    outputClosed ? undefined : "the return type is not a project-owned closed discriminated union",
    outputHasFallback ? undefined : "the return union lacks the registered fallback variant",
    implementationHasFallback
      ? undefined
      : "the implementation never explicitly returns the fallback variant",
  ].filter((failure): failure is string => failure !== undefined);
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/open-protocol-normalization",
      node,
      `Open-protocol adapter ${identity.symbolPath} is invalid: ${failures.join("; ")}.`,
      "Normalize the exact external protocol to a project-owned closed union and explicitly return the registered fallback variant.",
    ),
  );
}

function openProtocolSwitchInputExpression(node: ts.SwitchStatement): ts.Expression {
  if (
    ts.isPropertyAccessExpression(node.expression) ||
    ts.isElementAccessExpression(node.expression)
  ) {
    return node.expression.expression;
  }
  return node.expression;
}

function analyzeOpenProtocolSwitch(
  node: ts.SwitchStatement,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const input = openProtocolSwitchInputExpression(node);
  const adapters = workspace.openProtocolAdapters.filter((adapter) =>
    expressionIsExactExternalProtocol(
      input,
      adapter.externalProtocol.package,
      adapter.externalProtocol.exportName,
      checker,
      packageRoots,
    ),
  );
  if (adapters.length === 0) return;
  const identity = nodeIdentity(node, workspaceRoot);
  if (adapters.some((adapter) => identityOwns(adapter.identity, identity))) return;
  const protocols = adapters
    .map((adapter) => `${adapter.externalProtocol.package}#${adapter.externalProtocol.exportName}`)
    .join(", ");
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/open-protocol-normalization",
      node,
      `Open external protocol ${protocols} is switched directly in ${identity.symbolPath}.`,
      "Call the exactly registered open-protocol adapter and switch only on its closed local projection.",
    ),
  );
}

export function analyzeWorkspace(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[] = [
    { packageName: workspace.packageName, root: workspaceRoot },
  ],
): readonly ArchitectureDiagnostic[] {
  assertOpenProtocolAdaptersResolve(workspace, workspaceRoot, program);
  const checker = program.getTypeChecker();
  const diagnostics: ArchitectureDiagnostic[] = [];
  const reportedPredicates = new Set<string>();
  const reportedContracts = new Set<string>();
  const reportedMaps = new Set<string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isProductionSource(sourceFile, workspaceRoot)) continue;
    const module = relativeModulePath(workspaceRoot, sourceFile);
    const activeRules = new Set(
      ARCHITECTURE_RULES.filter((rule) => ruleApplies(workspace, rule, module)),
    );
    const candidateNames = callCandidateNames(sourceFile, workspace, activeRules);
    const sourceExports = activeRules.has("architecture/no-unhandled-exception-contract")
      ? exportedSymbols(sourceFile, checker)
      : new Set<ts.Symbol>();

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && candidateNames.has(expressionName(node.expression) ?? "")) {
        analyzeCall(
          node,
          checker,
          workspace,
          workspaceRoot,
          activeRules,
          packageRoots,
          diagnostics,
        );
      }
      if (activeRules.has("architecture/no-domain-unknown") && ts.isParameter(node)) {
        analyzeParameter(node, checker, workspace, workspaceRoot, diagnostics);
      }
      if (
        activeRules.has("architecture/no-unknown-assertion") &&
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      ) {
        analyzeAssertion(node, checker, workspace, workspaceRoot, diagnostics);
      }
      if (activeRules.has("architecture/no-rich-unknown-predicate") && ts.isFunctionLike(node)) {
        analyzePredicate(node, checker, workspace, workspaceRoot, diagnostics, reportedPredicates);
      }
      if (
        activeRules.has("architecture/closed-union-exhaustiveness") &&
        ts.isSwitchStatement(node)
      ) {
        analyzeClosedUnionSwitch(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
        );
      }
      if (activeRules.has("architecture/closed-union-map-exhaustiveness")) {
        if (
          (ts.isVariableDeclaration(node) ||
            ts.isPropertyDeclaration(node) ||
            ts.isPropertyAssignment(node)) &&
          node.initializer
        ) {
          analyzeDeclaredClosedUnionMap(
            node,
            checker,
            workspace,
            workspaceRoot,
            packageRoots,
            diagnostics,
            reportedMaps,
          );
        }
        if (ts.isElementAccessExpression(node) && node.argumentExpression) {
          const domain = literalDomain(
            checker.getTypeAtLocation(node.argumentExpression),
            checker,
            packageRoots,
            checker.getTypeAtLocation(node.argumentExpression),
            expressionTypeIsProjectOwned(node.argumentExpression, checker, packageRoots),
          );
          const resolution = mapResolutionFromExpression(node.expression, checker);
          if (domain && resolution) {
            analyzeClosedUnionMap(
              resolution,
              domain,
              checker,
              workspace,
              workspaceRoot,
              packageRoots,
              diagnostics,
              reportedMaps,
            );
          }
        }
      }
      if (activeRules.has("architecture/open-protocol-normalization") && ts.isFunctionLike(node)) {
        analyzeOpenProtocolAdapter(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
        );
      }
      if (
        activeRules.has("architecture/open-protocol-normalization") &&
        ts.isSwitchStatement(node)
      ) {
        analyzeOpenProtocolSwitch(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
        );
      }
      if (
        ts.isFunctionLike(node) &&
        (activeRules.has("architecture/no-unhandled-exception-contract") ||
          activeRules.has("architecture/fallible-api-result"))
      ) {
        analyzeResultContract(
          node,
          checker,
          workspace,
          workspaceRoot,
          activeRules,
          packageRoots,
          diagnostics,
          reportedContracts,
          sourceExports,
        );
      }
      if (
        activeRules.has("architecture/no-unhandled-exception-contract") &&
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      ) {
        analyzeDeclaredResultContract(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
          reportedContracts,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return [
    ...new Map(diagnostics.map((diagnostic) => [diagnostic.fingerprint, diagnostic])).values(),
  ];
}
