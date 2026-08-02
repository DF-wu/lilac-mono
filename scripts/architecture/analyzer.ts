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
    workspace.exceptionAdapters.some(
      (adapter) =>
        adapter.direction !== "signal-host" && identityMatches(adapter.identity, identity),
    )
  ) {
    return;
  }
  if (workspace.opaqueUnknown.some((exception) => identityMatches(exception.identity, identity)))
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

export function analyzeWorkspace(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[] = [
    { packageName: workspace.packageName, root: workspaceRoot },
  ],
): readonly ArchitectureDiagnostic[] {
  const checker = program.getTypeChecker();
  const diagnostics: ArchitectureDiagnostic[] = [];
  const reportedPredicates = new Set<string>();
  const reportedContracts = new Set<string>();

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
