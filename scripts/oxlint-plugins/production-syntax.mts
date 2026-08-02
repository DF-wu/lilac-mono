import { defineRule } from "@oxlint/plugins";

import ts from "typescript-codegen";

import {
  architectureManifest,
  type ArchitectureManifest,
  type ExceptionDirection,
} from "../architecture/manifest.ts";
import {
  type ExceptionFlowKind,
  SYNTACTIC_POLICY,
  type SyntacticPolicy,
} from "./syntax-policy.mts";
import {
  createFinding,
  isExcludedProductionFile,
  normalizeFilePath,
  scriptKindFor,
  type SyntacticFinding,
  sourceIdentity,
} from "./syntax-rule-utils.mts";

export type LocalRecordGuardKind = "local-record-guard";
export type ResultCallbackKind = "inline-async-result-callback";
export type NestedTernaryKind = "nested-ternary";

function sourceFileOf(sourceText: string, filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
}

function propertyAccessParts(
  expression: ts.Expression,
): readonly [ts.Expression, string] | undefined {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return [unwrapped.expression, unwrapped.name.text];
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    unwrapped.argumentExpression &&
    ts.isStringLiteral(unwrapped.argumentExpression)
  ) {
    return [unwrapped.expression, unwrapped.argumentExpression.text];
  }
  return undefined;
}

function unwrappedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isGlobalThis(expression: ts.Expression): boolean {
  const unwrapped = unwrappedExpression(expression);
  return ts.isIdentifier(unwrapped) && unwrapped.text === "globalThis";
}

function isGlobalPromiseExpression(
  expression: ts.Expression,
  constructorNames: ReadonlyMap<string, number>,
  at: number,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const availableAt = constructorNames.get(unwrapped.text);
    return availableAt !== undefined && availableAt <= at;
  }
  const parts = propertyAccessParts(unwrapped);
  return !!parts && isGlobalThis(parts[0]) && parts[1] === "Promise";
}

function collectBindingNameCounts(sourceFile: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      counts.set(name.text, (counts.get(name.text) ?? 0) + 1);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) add(element.name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) add(node.name);
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name);
    if (ts.isImportClause(node) && node.name) add(node.name);
    if (
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      add(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return counts;
}

function setProvenance(
  provenance: Map<string, number>,
  counts: ReadonlyMap<string, number>,
  name: string,
  position: number,
): boolean {
  if (counts.get(name) !== 1) return false;
  const current = provenance.get(name);
  if (current !== undefined && current <= position) return false;
  provenance.set(name, position);
  return true;
}

interface PromiseProvenance {
  readonly asyncFunctions: ReadonlyMap<string, number>;
  readonly constructors: ReadonlyMap<string, number>;
  readonly globalFetchAvailable: boolean;
  readonly promiseFunctions: ReadonlyMap<string, number>;
  readonly promiseModuleNamespaces: ReadonlyMap<string, number>;
  readonly promiseValues: ReadonlyMap<string, number>;
  readonly rejectFunctions: ReadonlyMap<string, number>;
}

const PROMISE_STATIC_PRODUCERS = new Set([
  "all",
  "allSettled",
  "any",
  "race",
  "reject",
  "resolve",
  "try",
]);

const PROMISE_ONLY_STANDARD_MODULES = new Set([
  "dns/promises",
  "fs/promises",
  "node:dns/promises",
  "node:fs/promises",
  "node:stream/promises",
  "node:timers/promises",
  "stream/promises",
  "timers/promises",
]);

function isPromiseStaticCall(
  call: ts.CallExpression,
  constructors: ReadonlyMap<string, number>,
): boolean {
  const parts = propertyAccessParts(call.expression);
  return (
    !!parts &&
    PROMISE_STATIC_PRODUCERS.has(parts[1]) &&
    isGlobalPromiseExpression(parts[0], constructors, call.getStart())
  );
}

function isGlobalFetchExpression(
  expression: ts.Expression,
  provenance: PromiseProvenance,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text === "fetch" && provenance.globalFetchAvailable;
  }
  const parts = propertyAccessParts(unwrapped);
  return !!parts && isGlobalThis(parts[0]) && parts[1] === "fetch";
}

function isKnownPromiseExpression(
  expression: ts.Expression,
  provenance: PromiseProvenance,
  at: number,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const availableAt = provenance.promiseValues.get(unwrapped.text);
    return availableAt !== undefined && availableAt <= at;
  }
  if (ts.isAwaitExpression(unwrapped)) return false;
  if (ts.isNewExpression(unwrapped)) {
    return isGlobalPromiseExpression(unwrapped.expression, provenance.constructors, at);
  }
  if (!ts.isCallExpression(unwrapped)) return false;
  if (isPromiseStaticCall(unwrapped, provenance.constructors)) return true;
  const callee = unwrappedExpression(unwrapped.expression);
  if (ts.isIdentifier(callee)) {
    if ((provenance.asyncFunctions.get(callee.text) ?? Number.POSITIVE_INFINITY) <= at) return true;
    if ((provenance.promiseFunctions.get(callee.text) ?? Number.POSITIVE_INFINITY) <= at)
      return true;
  }
  if (isGlobalFetchExpression(callee, provenance)) return true;
  if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
    return (
      callee.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true
    );
  }
  const parts = propertyAccessParts(callee);
  if (
    parts &&
    ts.isIdentifier(unwrappedExpression(parts[0])) &&
    (provenance.promiseModuleNamespaces.get(unwrappedExpression(parts[0]).getText()) ??
      Number.POSITIVE_INFINITY) <= at
  ) {
    return true;
  }
  return (
    !!parts &&
    (parts[1] === "catch" || parts[1] === "finally" || parts[1] === "then") &&
    isKnownPromiseExpression(parts[0], provenance, at)
  );
}

function collectPromiseProvenance(sourceFile: ts.SourceFile): PromiseProvenance {
  const counts = collectBindingNameCounts(sourceFile);
  const constructors = new Map<string, number>();
  const rejectFunctions = new Map<string, number>();
  const promiseFunctions = new Map<string, number>();
  const promiseModuleNamespaces = new Map<string, number>();
  const promiseValues = new Map<string, number>();
  const asyncFunctions = new Map<string, number>();
  if (!counts.has("Promise")) constructors.set("Promise", 0);
  const globalFetchAvailable = !counts.has("fetch");
  const variableDeclarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !PROMISE_ONLY_STANDARD_MODULES.has(statement.moduleSpecifier.text) ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }
    const importClause = statement.importClause;
    if (!importClause) continue;
    if (importClause.name) {
      setProvenance(promiseModuleNamespaces, counts, importClause.name.text, 0);
    }
    const bindings = importClause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      setProvenance(promiseModuleNamespaces, counts, bindings.name.text, 0);
      continue;
    }
    for (const specifier of bindings.elements) {
      if (!specifier.isTypeOnly) {
        setProvenance(promiseFunctions, counts, specifier.name.text, 0);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      setProvenance(asyncFunctions, counts, node.name.text, 0);
    } else if (ts.isVariableDeclaration(node)) {
      variableDeclarations.push(node);
      const initializer = node.initializer && unwrappedExpression(node.initializer);
      if (
        ts.isIdentifier(node.name) &&
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
        initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        setProvenance(asyncFunctions, counts, node.name.text, node.getStart(sourceFile));
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      assignments.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of variableDeclarations) {
      const initializer = declaration.initializer;
      if (!initializer || !ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      const position = declaration.getStart(sourceFile);
      if (isGlobalPromiseExpression(initializer, constructors, position)) {
        changed = setProvenance(constructors, counts, name, position) || changed;
      }
      const parts = propertyAccessParts(unwrappedExpression(initializer));
      if (
        parts &&
        parts[1] === "reject" &&
        isGlobalPromiseExpression(parts[0], constructors, position)
      ) {
        changed = setProvenance(rejectFunctions, counts, name, position) || changed;
      }
      const current: PromiseProvenance = {
        asyncFunctions,
        constructors,
        globalFetchAvailable,
        promiseFunctions,
        promiseModuleNamespaces,
        promiseValues,
        rejectFunctions,
      };
      if (isKnownPromiseExpression(initializer, current, position)) {
        changed = setProvenance(promiseValues, counts, name, position) || changed;
      }
    }
    for (const assignment of assignments) {
      if (!ts.isIdentifier(assignment.left)) continue;
      const current: PromiseProvenance = {
        asyncFunctions,
        constructors,
        globalFetchAvailable,
        promiseFunctions,
        promiseModuleNamespaces,
        promiseValues,
        rejectFunctions,
      };
      if (isKnownPromiseExpression(assignment.right, current, assignment.getStart(sourceFile))) {
        changed =
          setProvenance(
            promiseValues,
            counts,
            assignment.left.text,
            assignment.getStart(sourceFile),
          ) || changed;
      }
    }
  }
  return {
    asyncFunctions,
    constructors,
    globalFetchAvailable,
    promiseFunctions,
    promiseModuleNamespaces,
    promiseValues,
    rejectFunctions,
  };
}

function promiseRejectCall(call: ts.CallExpression, provenance: PromiseProvenance): boolean {
  const callee = unwrappedExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const availableAt = provenance.rejectFunctions.get(callee.text);
    return availableAt !== undefined && availableAt <= call.getStart();
  }
  const parts = propertyAccessParts(callee);
  return (
    !!parts &&
    parts[1] === "reject" &&
    isGlobalPromiseExpression(parts[0], provenance.constructors, call.getStart())
  );
}

function isNullishCallback(expression: ts.Expression): boolean {
  const unwrapped = unwrappedExpression(expression);
  return (
    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") ||
    (ts.isVoidExpression(unwrapped) && unwrapped.expression.kind === ts.SyntaxKind.NumericLiteral)
  );
}

function usedExecutorRejectCalls(
  node: ts.NewExpression,
  provenance: PromiseProvenance,
): ts.CallExpression[] {
  if (!isGlobalPromiseExpression(node.expression, provenance.constructors, node.getStart()))
    return [];
  const executor = node.arguments?.[0];
  if (!executor || (!ts.isArrowFunction(executor) && !ts.isFunctionExpression(executor))) return [];
  const rejectParameter = executor.parameters[1]?.name;
  if (!rejectParameter || !ts.isIdentifier(rejectParameter)) return [];
  const aliases = new Set([rejectParameter.text]);
  let changed = true;
  while (changed) {
    changed = false;
    const collect = (child: ts.Node): void => {
      if (
        ts.isVariableDeclaration(child) &&
        ts.isIdentifier(child.name) &&
        child.initializer &&
        ts.isIdentifier(unwrappedExpression(child.initializer)) &&
        aliases.has(unwrappedExpression(child.initializer).getText()) &&
        !aliases.has(child.name.text)
      ) {
        aliases.add(child.name.text);
        changed = true;
      }
      ts.forEachChild(child, collect);
    };
    collect(executor.body);
  }
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(unwrappedExpression(child.expression)) &&
      aliases.has(unwrappedExpression(child.expression).getText())
    ) {
      calls.push(child);
    }
    ts.forEachChild(child, visit);
  };
  visit(executor.body);
  return calls;
}

function collectStreamControllers(sourceFile: ts.SourceFile): Set<string> {
  const controllers = new Set<string>();
  const addParameter = (parameter: ts.ParameterDeclaration | undefined): void => {
    if (parameter && ts.isIdentifier(parameter.name)) controllers.add(parameter.name.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && node.type && /Stream.*Controller/u.test(node.type.getText())) {
      addParameter(node);
    }
    if (
      ts.isNewExpression(node) &&
      /^(?:Readable|Transform)Stream$/u.test(node.expression.getText())
    ) {
      const source = node.arguments?.[0];
      if (source && (ts.isArrowFunction(source) || ts.isFunctionExpression(source))) {
        addParameter(source.parameters[0]);
      } else if (source && ts.isObjectLiteralExpression(source)) {
        for (const member of source.properties) {
          if (!ts.isMethodDeclaration(member)) continue;
          const name = member.name.getText().replaceAll(/["']/gu, "");
          if (name === "start" || name === "pull" || name === "flush") {
            addParameter(member.parameters[0]);
          } else if (name === "transform") {
            addParameter(member.parameters[1]);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return controllers;
}

function looksLikeErrorValue(expression: ts.Expression): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isNewExpression(unwrapped)) return true;
  return ts.isIdentifier(unwrapped) && /^(?:cause|e|err|error|reason)$/iu.test(unwrapped.text);
}

function isExplicitHostErrorSignal(
  call: ts.CallExpression,
  streamControllers: ReadonlySet<string>,
): boolean {
  const parts = propertyAccessParts(call.expression);
  if (!parts) return false;
  const [receiver, method] = parts;
  if (method === "emit") {
    const eventName = call.arguments[0];
    return !!eventName && ts.isStringLiteral(eventName) && eventName.text === "error";
  }
  if (method === "destroy") {
    const error = call.arguments[0];
    return !!error && !ts.isSpreadElement(error) && looksLikeErrorValue(error);
  }
  return method === "error" && ts.isIdentifier(receiver) && streamControllers.has(receiver.text);
}

const DIRECTION_KINDS = {
  "capture-external": ["catch-clause", "promise-catch", "rejection-callback"],
  "signal-host": ["promise-reject", "rejection-callback", "stream-error-signal", "throw"],
  "observe-panic": ["catch-clause", "promise-catch", "rejection-callback", "throw"],
} as const satisfies Readonly<Record<ExceptionDirection, readonly ExceptionFlowKind[]>>;

function normalizedAdapterModule(workspaceRoot: string, module: string): string {
  const normalizedRoot = normalizeFilePath(workspaceRoot).replace(/\/$/u, "");
  const normalizedModule = normalizeFilePath(module).replace(/^\.\//u, "");
  const relative = normalizedModule.startsWith(`${normalizedRoot}/`)
    ? normalizedModule.slice(normalizedRoot.length + 1)
    : normalizedModule;
  return relative.replace(/\.(?:[cm]?[jt]sx?)$/iu, "");
}

function adapterAllows(
  finding: SyntacticFinding<ExceptionFlowKind>,
  manifest: ArchitectureManifest,
): boolean {
  const workspace = manifest.workspaces.find((candidate) => candidate.root === finding.workspace);
  if (!workspace) return false;
  return workspace.exceptionAdapters.some(
    (adapter) =>
      normalizedAdapterModule(workspace.root, adapter.identity.module) === finding.module &&
      adapter.identity.exportName === finding.symbol &&
      DIRECTION_KINDS[adapter.direction].some((kind) => kind === finding.kind),
  );
}

export function findExceptionFlowViolations(
  sourceText: string,
  filePath = "apps/example/src/example.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
  manifest: ArchitectureManifest = architectureManifest,
): SyntacticFinding<ExceptionFlowKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  const sourceFile = sourceFileOf(sourceText, filePath);
  const provenance = collectPromiseProvenance(sourceFile);
  const streamControllers = collectStreamControllers(sourceFile);
  const findings: SyntacticFinding<ExceptionFlowKind>[] = [];
  const add = (node: ts.Node, kind: ExceptionFlowKind, message: string): void => {
    const finding = createFinding(sourceFile, filePath, node, kind, message);
    if (!adapterAllows(finding, manifest)) findings.push(finding);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) {
      add(
        node,
        "throw",
        "Return a typed Result error; throw only in an exactly registered adapter",
      );
    } else if (ts.isCatchClause(node)) {
      add(
        node,
        "catch-clause",
        "Capture the external exception in an exactly registered adapter; try/finally remains allowed",
      );
    } else if (ts.isNewExpression(node)) {
      for (const call of usedExecutorRejectCalls(node, provenance)) {
        add(
          call,
          "rejection-callback",
          "Return Promise<Result<T, E>> instead of invoking a Promise reject channel",
        );
      }
    } else if (ts.isCallExpression(node)) {
      if (promiseRejectCall(node, provenance)) {
        add(node, "promise-reject", "Return Result.err instead of Promise.reject");
      } else {
        const parts = propertyAccessParts(node.expression);
        if (
          parts &&
          parts[1] === "catch" &&
          isKnownPromiseExpression(parts[0], provenance, node.getStart(sourceFile))
        ) {
          add(
            node,
            "promise-catch",
            "Capture rejection in an exactly registered external-to-result adapter instead of .catch",
          );
        } else if (
          parts &&
          parts[1] === "then" &&
          node.arguments[1] &&
          !ts.isSpreadElement(node.arguments[1]) &&
          !isNullishCallback(node.arguments[1]) &&
          isKnownPromiseExpression(parts[0], provenance, node.getStart(sourceFile))
        ) {
          add(
            node.arguments[1],
            "rejection-callback",
            "Capture rejection in a named Result-returning adapter before composition",
          );
        } else if (isExplicitHostErrorSignal(node, streamControllers)) {
          add(
            node,
            "stream-error-signal",
            "Map the Result to the host error signal in an exactly registered framework adapter",
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function declarationName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

export function findLocalRecordGuardViolations(
  sourceText: string,
  filePath = "apps/example/src/example.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
): SyntacticFinding<LocalRecordGuardKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  const sourceFile = sourceFileOf(sourceText, filePath);
  const identity = sourceIdentity(filePath);
  const findings: SyntacticFinding<LocalRecordGuardKind>[] = [];
  const names = new Set(policy.recordGuardNames);
  const visit = (node: ts.Node): void => {
    const name = declarationName(node);
    if (name && names.has(name)) {
      const canonical = policy.canonicalRecordGuards.some(
        (guard) =>
          guard.workspace === identity.workspace &&
          guard.module === identity.module &&
          guard.symbol === name,
      );
      if (!canonical) {
        findings.push(
          createFinding(
            sourceFile,
            filePath,
            node,
            "local-record-guard",
            `Import the canonical ${name} utility instead of declaring a local duplicate`,
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

const RESULT_COMBINATORS = new Set([
  "andThen",
  "andThenAsync",
  "map",
  "mapError",
  "match",
  "tap",
  "tapAsync",
  "tapBoth",
  "tapBothAsync",
  "tapError",
  "tapErrorAsync",
  "tryRecover",
  "tryRecoverAsync",
]);
const RESULT_PRODUCERS = new Set(["err", "ok", "try"]);

interface ResultProvenance {
  readonly moduleNamespaces: ReadonlySet<string>;
  readonly resultFactories: ReadonlyMap<string, number>;
  readonly resultNamespaces: ReadonlyMap<string, number>;
  readonly resultValues: ReadonlyMap<string, number>;
}

function isResultNamespaceExpression(
  expression: ts.Expression,
  provenance: ResultProvenance,
  at: number,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const availableAt = provenance.resultNamespaces.get(unwrapped.text);
    return availableAt !== undefined && availableAt <= at;
  }
  const parts = propertyAccessParts(unwrapped);
  return (
    !!parts &&
    parts[1] === "Result" &&
    ts.isIdentifier(parts[0]) &&
    provenance.moduleNamespaces.has(parts[0].text)
  );
}

function isKnownResultExpression(
  expression: ts.Expression,
  provenance: ResultProvenance,
  at: number,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const availableAt = provenance.resultValues.get(unwrapped.text);
    return availableAt !== undefined && availableAt <= at;
  }
  if (!ts.isCallExpression(unwrapped)) return false;
  if (ts.isIdentifier(unwrapped.expression)) {
    const availableAt = provenance.resultFactories.get(unwrapped.expression.text);
    return availableAt !== undefined && availableAt <= at;
  }
  const parts = propertyAccessParts(unwrapped.expression);
  if (!parts) return false;
  if (
    RESULT_PRODUCERS.has(parts[1]) &&
    isResultNamespaceExpression(parts[0], provenance, unwrapped.getStart())
  ) {
    return true;
  }
  return (
    RESULT_COMBINATORS.has(parts[1]) &&
    isKnownResultExpression(parts[0], provenance, unwrapped.getStart()) &&
    !parts[1].endsWith("Async") &&
    parts[1] !== "match"
  );
}

function typeIsImportedResult(
  type: ts.TypeNode | undefined,
  resultNames: ReadonlySet<string>,
): boolean {
  if (!type) return false;
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName;
    return ts.isIdentifier(name) && resultNames.has(name.text);
  }
  return false;
}

function collectResultProvenance(sourceFile: ts.SourceFile): ResultProvenance {
  const counts = collectBindingNameCounts(sourceFile);
  const moduleNamespaces = new Set<string>();
  const importedResultTypeNames = new Set<string>();
  const resultFactories = new Map<string, number>();
  const resultNamespaces = new Map<string, number>();
  const resultValues = new Map<string, number>();
  const declarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "better-result"
    ) {
      continue;
    }
    for (const specifier of statement.importClause?.namedBindings
      ? ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements
        : [statement.importClause.namedBindings]
      : []) {
      if (ts.isNamespaceImport(specifier)) {
        moduleNamespaces.add(specifier.name.text);
        continue;
      }
      const importedName = (specifier.propertyName ?? specifier.name).text;
      if (importedName === "Result") {
        setProvenance(
          resultNamespaces,
          counts,
          specifier.name.text,
          statement.getStart(sourceFile),
        );
        importedResultTypeNames.add(specifier.name.text);
      } else if (importedName === "ok" || importedName === "err") {
        setProvenance(resultFactories, counts, specifier.name.text, statement.getStart(sourceFile));
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      typeIsImportedResult(node.type, importedResultTypeNames)
    ) {
      setProvenance(resultValues, counts, node.name.text, node.getStart(sourceFile));
    }
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      typeIsImportedResult(node.type, importedResultTypeNames)
    ) {
      setProvenance(resultValues, counts, node.name.text, node.getStart(sourceFile));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      assignments.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    const current: ResultProvenance = {
      moduleNamespaces,
      resultFactories,
      resultNamespaces,
      resultValues,
    };
    for (const declaration of declarations) {
      if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      const position = declaration.getStart(sourceFile);
      if (isResultNamespaceExpression(declaration.initializer, current, position)) {
        changed = setProvenance(resultNamespaces, counts, name, position) || changed;
      }
      if (isKnownResultExpression(declaration.initializer, current, position)) {
        changed = setProvenance(resultValues, counts, name, position) || changed;
      }
    }
    for (const assignment of assignments) {
      if (!ts.isIdentifier(assignment.left)) continue;
      if (isKnownResultExpression(assignment.right, current, assignment.getStart(sourceFile))) {
        changed =
          setProvenance(
            resultValues,
            counts,
            assignment.left.text,
            assignment.getStart(sourceFile),
          ) || changed;
      }
    }
  }
  return { moduleNamespaces, resultFactories, resultNamespaces, resultValues };
}

function inlineAsyncCallbacks(node: ts.Node): ts.FunctionLikeDeclaration[] {
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return [node];
  }
  if (!ts.isObjectLiteralExpression(node)) return [];
  const callbacks: ts.FunctionLikeDeclaration[] = [];
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      callbacks.push(...inlineAsyncCallbacks(property.initializer));
    } else if (
      ts.isMethodDeclaration(property) &&
      property.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      callbacks.push(property);
    }
  }
  return callbacks;
}

export function findInlineAsyncResultCallbackViolations(
  sourceText: string,
  filePath = "apps/example/src/example.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
): SyntacticFinding<ResultCallbackKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  const sourceFile = sourceFileOf(sourceText, filePath);
  const provenance = collectResultProvenance(sourceFile);
  const findings: SyntacticFinding<ResultCallbackKind>[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const parts = propertyAccessParts(node.expression);
      if (parts && RESULT_COMBINATORS.has(parts[1])) {
        const isStatic = isResultNamespaceExpression(
          parts[0],
          provenance,
          node.getStart(sourceFile),
        );
        const isInstance = isKnownResultExpression(parts[0], provenance, node.getStart(sourceFile));
        if (isStatic || isInstance) {
          for (const argument of node.arguments) {
            for (const callback of inlineAsyncCallbacks(argument)) {
              findings.push(
                createFinding(
                  sourceFile,
                  filePath,
                  callback,
                  "inline-async-result-callback",
                  "Use a named Result-returning adapter or declarative Result.gen workflow",
                ),
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function nearestExpressionParent(node: ts.Node): ts.Node | undefined {
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return parent;
}

export function findNestedTernaryViolations(
  sourceText: string,
  filePath = "apps/example/src/example.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
): SyntacticFinding<NestedTernaryKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  const sourceFile = sourceFileOf(sourceText, filePath);
  const findings: SyntacticFinding<NestedTernaryKind>[] = [];
  const visit = (node: ts.Node): void => {
    const parent = nearestExpressionParent(node);
    if (ts.isConditionalExpression(node) && parent && ts.isConditionalExpression(parent)) {
      findings.push(
        createFinding(
          sourceFile,
          filePath,
          node,
          "nested-ternary",
          "Replace the nested ternary with an if/else, switch, or named helper",
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function ruleFromFinder<Kind extends string>(
  description: string,
  finder: (sourceText: string, filePath: string) => readonly SyntacticFinding<Kind>[],
) {
  return defineRule({
    meta: { type: "problem", docs: { description }, schema: [] },
    create(context) {
      return {
        Program() {
          for (const violation of finder(context.sourceCode.text, context.filename)) {
            context.report({
              loc: { line: violation.line, column: violation.column - 1 },
              message: violation.message,
            });
          }
        },
      };
    },
  });
}

export const noExceptionFlowRule = ruleFromFinder(
  "Disallow production exception flow outside exactly registered adapters",
  findExceptionFlowViolations,
);
export const noLocalIsRecordRule = ruleFromFinder(
  "Disallow local duplicates of canonical record guards",
  findLocalRecordGuardViolations,
);
export const noInlineAsyncResultCallbackRule = ruleFromFinder(
  "Disallow inline async callbacks in proven Result combinators",
  findInlineAsyncResultCallbackViolations,
);
