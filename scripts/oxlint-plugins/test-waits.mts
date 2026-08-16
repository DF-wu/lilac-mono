import { definePlugin, defineRule } from "@oxlint/plugins";

// The workspace aliases the compiler-API build of TypeScript under this package name.
import ts from "typescript-codegen";

const JUSTIFICATION_PREFIX = "test-wait-justification:";

export type TestWaitKind = "bun-sleep" | "node-timer-promise" | "promise-timeout";

export interface TestWaitViolation {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly kind: TestWaitKind;
  readonly message: string;
}

interface AliasSets {
  readonly bunNamespaces: Set<string>;
  readonly bunSleep: Set<string>;
  readonly callbackTimer: Set<string>;
  readonly callbackTimerNamespaces: Set<string>;
  readonly fixedNumbers: Map<string, number>;
  readonly localWaitWrappers: Map<string, LocalWaitWrapper>;
  readonly promiseTimer: Set<string>;
  readonly promiseTimerNamespaces: Set<string>;
  readonly withResolversCallbacks: Set<string>;
  readonly withResolversObjects: Set<string>;
}

interface LocalWaitWrapper {
  readonly durationParameterIndex: number;
  readonly kind: TestWaitKind;
}

function moduleNameOf(node: ts.ImportDeclaration): string | undefined {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}

function isCallbackTimerModule(moduleName: string): boolean {
  return moduleName === "node:timers" || moduleName === "timers";
}

function isPromiseTimerModule(moduleName: string): boolean {
  return moduleName === "node:timers/promises" || moduleName === "timers/promises";
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function requiredModuleName(expression: ts.Expression): string | undefined {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "require" ||
    expression.arguments.length !== 1
  ) {
    return undefined;
  }
  const argument = expression.arguments[0];
  return argument && ts.isStringLiteral(argument) ? argument.text : undefined;
}

function propertyAccessParts(expression: ts.Expression): readonly [string, string] | undefined {
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return [expression.expression.text, expression.name.text];
  }
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.argumentExpression &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return [expression.expression.text, expression.argumentExpression.text];
  }
  return undefined;
}

function isPromiseWithResolversCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const parts = propertyAccessParts(expression.expression);
  return !!parts && parts[0] === "Promise" && parts[1] === "withResolvers";
}

function collectAliases(sourceFile: ts.SourceFile): AliasSets {
  const aliases: AliasSets = {
    bunNamespaces: new Set(["Bun"]),
    bunSleep: new Set(),
    callbackTimer: new Set(),
    callbackTimerNamespaces: new Set(),
    fixedNumbers: new Map(),
    localWaitWrappers: new Map(),
    promiseTimer: new Set(),
    promiseTimerNamespaces: new Set(),
    withResolversCallbacks: new Set(),
    withResolversObjects: new Set(),
  };
  const variableDeclarations: ts.VariableDeclaration[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = moduleNameOf(node);
      const bindings = node.importClause?.namedBindings;
      if (moduleName && bindings) {
        if (ts.isNamespaceImport(bindings)) {
          if (isCallbackTimerModule(moduleName))
            aliases.callbackTimerNamespaces.add(bindings.name.text);
          if (isPromiseTimerModule(moduleName))
            aliases.promiseTimerNamespaces.add(bindings.name.text);
        } else {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text !== "setTimeout") continue;
            if (isCallbackTimerModule(moduleName)) aliases.callbackTimer.add(element.name.text);
            if (isPromiseTimerModule(moduleName)) aliases.promiseTimer.add(element.name.text);
          }
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      variableDeclarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const constantNameCounts = new Map<string, number>();
  for (const declaration of variableDeclarations) {
    if (
      ts.isIdentifier(declaration.name) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    ) {
      constantNameCounts.set(
        declaration.name.text,
        (constantNameCounts.get(declaration.name.text) ?? 0) + 1,
      );
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const add = (set: Set<string>, value: string): void => {
      if (!set.has(value)) {
        set.add(value);
        changed = true;
      }
    };

    for (const declaration of variableDeclarations) {
      const initializer = declaration.initializer;
      if (!initializer) continue;
      const moduleName = requiredModuleName(initializer);

      if (ts.isIdentifier(declaration.name)) {
        const localName = declaration.name.text;
        if (isPromiseWithResolversCall(initializer)) {
          add(aliases.withResolversObjects, localName);
          continue;
        }
        if (moduleName) {
          if (isCallbackTimerModule(moduleName)) add(aliases.callbackTimerNamespaces, localName);
          if (isPromiseTimerModule(moduleName)) add(aliases.promiseTimerNamespaces, localName);
          continue;
        }
        if (ts.isIdentifier(initializer)) {
          if (aliases.withResolversCallbacks.has(initializer.text)) {
            add(aliases.withResolversCallbacks, localName);
          }
          if (aliases.withResolversObjects.has(initializer.text)) {
            add(aliases.withResolversObjects, localName);
          }
          if (aliases.bunNamespaces.has(initializer.text)) add(aliases.bunNamespaces, localName);
          if (initializer.text === "setTimeout" || aliases.callbackTimer.has(initializer.text)) {
            add(aliases.callbackTimer, localName);
          }
          if (aliases.callbackTimerNamespaces.has(initializer.text)) {
            add(aliases.callbackTimerNamespaces, localName);
          }
          if (aliases.bunSleep.has(initializer.text)) add(aliases.bunSleep, localName);
          if (aliases.promiseTimer.has(initializer.text)) add(aliases.promiseTimer, localName);
          if (aliases.promiseTimerNamespaces.has(initializer.text)) {
            add(aliases.promiseTimerNamespaces, localName);
          }
          continue;
        }
        const parts = propertyAccessParts(initializer);
        if (parts && aliases.withResolversObjects.has(parts[0]) && parts[1] === "resolve") {
          add(aliases.withResolversCallbacks, localName);
          continue;
        }
        if (!parts || (parts[1] !== "setTimeout" && parts[1] !== "sleep")) continue;
        if (aliases.bunNamespaces.has(parts[0]) && parts[1] === "sleep") {
          add(aliases.bunSleep, localName);
        }
        if (aliases.callbackTimerNamespaces.has(parts[0]) && parts[1] === "setTimeout") {
          add(aliases.callbackTimer, localName);
        }
        if (aliases.promiseTimerNamespaces.has(parts[0]) && parts[1] === "setTimeout") {
          add(aliases.promiseTimer, localName);
        }
        continue;
      }

      if (!ts.isObjectBindingPattern(declaration.name)) continue;
      const initializerName = ts.isIdentifier(initializer) ? initializer.text : undefined;
      const initializesWithResolvers = isPromiseWithResolversCall(initializer);
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const importedName = propertyNameText(element.propertyName ?? element.name);
        if (
          importedName === "resolve" &&
          (initializesWithResolvers ||
            (initializerName && aliases.withResolversObjects.has(initializerName)))
        ) {
          add(aliases.withResolversCallbacks, element.name.text);
        }
        if (
          initializerName &&
          aliases.bunNamespaces.has(initializerName) &&
          importedName === "sleep"
        ) {
          add(aliases.bunSleep, element.name.text);
        }
        if (initializerName && importedName === "setTimeout") {
          if (aliases.callbackTimerNamespaces.has(initializerName)) {
            add(aliases.callbackTimer, element.name.text);
          }
          if (aliases.promiseTimerNamespaces.has(initializerName)) {
            add(aliases.promiseTimer, element.name.text);
          }
        }
        if (moduleName && importedName === "setTimeout") {
          if (isCallbackTimerModule(moduleName)) add(aliases.callbackTimer, element.name.text);
          if (isPromiseTimerModule(moduleName)) add(aliases.promiseTimer, element.name.text);
        }
      }
    }

    for (const declaration of variableDeclarations) {
      if (
        !declaration.initializer ||
        !ts.isIdentifier(declaration.name) ||
        constantNameCounts.get(declaration.name.text) !== 1 ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        !(declaration.parent.flags & ts.NodeFlags.Const)
      ) {
        continue;
      }
      const value = evaluateFixedNumber(declaration.initializer, aliases.fixedNumbers);
      if (
        value !== undefined &&
        Number.isFinite(value) &&
        aliases.fixedNumbers.get(declaration.name.text) !== value
      ) {
        aliases.fixedNumbers.set(declaration.name.text, value);
        changed = true;
      }
    }
  }

  collectLocalWaitWrappers(sourceFile, aliases);
  return aliases;
}

function evaluateFixedNumber(
  expression: ts.Expression,
  fixedNumbers: ReadonlyMap<string, number>,
): number | undefined {
  if (ts.isIdentifier(expression)) return fixedNumbers.get(expression.text);
  if (ts.isParenthesizedExpression(expression)) {
    return evaluateFixedNumber(expression.expression, fixedNumbers);
  }
  if (ts.isNumericLiteral(expression)) return Number(expression.text.replaceAll("_", ""));
  if (ts.isPrefixUnaryExpression(expression)) {
    const operand = evaluateFixedNumber(expression.operand, fixedNumbers);
    if (operand === undefined) return undefined;
    if (expression.operator === ts.SyntaxKind.PlusToken) return operand;
    if (expression.operator === ts.SyntaxKind.MinusToken) return -operand;
    return undefined;
  }
  if (!ts.isBinaryExpression(expression)) return undefined;
  const left = evaluateFixedNumber(expression.left, fixedNumbers);
  const right = evaluateFixedNumber(expression.right, fixedNumbers);
  if (left === undefined || right === undefined) return undefined;
  switch (expression.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.SlashToken:
      return right === 0 ? undefined : left / right;
    default:
      return undefined;
  }
}

function hasNonnegativeFixedArgument(
  call: ts.CallExpression,
  index: number,
  aliases: AliasSets,
): boolean {
  const argument = call.arguments[index];
  if (!argument) return false;
  const value = evaluateFixedNumber(argument, aliases.fixedNumbers);
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function calledName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function isGuardCallback(callback: ts.Expression): boolean {
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
  if (ts.isBlock(callback.body)) {
    return (
      callback.body.statements.length > 0 &&
      callback.body.statements.every((statement) => {
        if (ts.isThrowStatement(statement)) return true;
        const expression = ts.isExpressionStatement(statement)
          ? statement.expression
          : ts.isReturnStatement(statement)
            ? statement.expression
            : undefined;
        if (!expression || !ts.isCallExpression(expression)) return false;
        const name = calledName(expression.expression);
        return name === "reject" || name === "abort";
      })
    );
  }
  if (!ts.isCallExpression(callback.body)) return false;
  const name = calledName(callback.body.expression);
  return name === "reject" || name === "abort";
}

function isRejectionOrAbortGuard(call: ts.CallExpression): boolean {
  const access = call.parent;
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.expression !== call ||
    access.name.text !== "then"
  ) {
    return false;
  }
  const thenCall = access.parent;
  return (
    ts.isCallExpression(thenCall) &&
    thenCall.expression === access &&
    !!thenCall.arguments[0] &&
    isGuardCallback(thenCall.arguments[0])
  );
}

function isBunSleepCall(call: ts.CallExpression, aliases: AliasSets): boolean {
  if (ts.isIdentifier(call.expression)) return aliases.bunSleep.has(call.expression.text);
  const parts = propertyAccessParts(call.expression);
  return !!parts && aliases.bunNamespaces.has(parts[0]) && parts[1] === "sleep";
}

function isPromiseTimerCall(call: ts.CallExpression, aliases: AliasSets): boolean {
  if (ts.isIdentifier(call.expression)) return aliases.promiseTimer.has(call.expression.text);
  const parts = propertyAccessParts(call.expression);
  return !!parts && parts[1] === "setTimeout" && aliases.promiseTimerNamespaces.has(parts[0]);
}

function isCallbackTimerCall(call: ts.CallExpression, aliases: AliasSets): boolean {
  if (ts.isIdentifier(call.expression)) {
    return call.expression.text === "setTimeout" || aliases.callbackTimer.has(call.expression.text);
  }
  const parts = propertyAccessParts(call.expression);
  return (
    !!parts &&
    parts[1] === "setTimeout" &&
    (parts[0] === "globalThis" ||
      parts[0] === "global" ||
      aliases.callbackTimerNamespaces.has(parts[0]))
  );
}

function functionCallsIdentifier(node: ts.Node, identifier: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === identifier
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function timerCallbackResolves(callback: ts.Expression, resolveName: string): boolean {
  if (ts.isIdentifier(callback)) return callback.text === resolveName;
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
    return functionCallsIdentifier(callback.body, resolveName);
  }
  return false;
}

function promiseUsesResolvingTimeout(
  expression: ts.NewExpression,
  aliases: AliasSets,
  durationMatches: (duration: ts.Expression) => boolean,
): boolean {
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "Promise")
    return false;
  const executor = expression.arguments?.[0];
  if (!executor || (!ts.isArrowFunction(executor) && !ts.isFunctionExpression(executor)))
    return false;
  const resolveParameter = executor.parameters[0]?.name;
  if (!resolveParameter || !ts.isIdentifier(resolveParameter)) return false;

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && isCallbackTimerCall(node, aliases)) {
      const callback = node.arguments[0];
      const duration = node.arguments[1];
      if (
        callback &&
        duration &&
        timerCallbackResolves(callback, resolveParameter.text) &&
        durationMatches(duration)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(executor.body);
  return found;
}

function promiseUsesFixedResolvingTimeout(
  expression: ts.NewExpression,
  aliases: AliasSets,
): boolean {
  return promiseUsesResolvingTimeout(expression, aliases, (duration) => {
    const value = evaluateFixedNumber(duration, aliases.fixedNumbers);
    return value !== undefined && Number.isFinite(value) && value >= 0;
  });
}

function isWithResolversCallback(expression: ts.Expression, aliases: AliasSets): boolean {
  if (ts.isIdentifier(expression)) return aliases.withResolversCallbacks.has(expression.text);
  const parts = propertyAccessParts(expression);
  return !!parts && aliases.withResolversObjects.has(parts[0]) && parts[1] === "resolve";
}

function timerCallbackUsesWithResolvers(callback: ts.Expression, aliases: AliasSets): boolean {
  if (isWithResolversCallback(callback, aliases)) return true;
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && isWithResolversCallback(node.expression, aliases)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return found;
}

function findDurationParameterIndex(
  expression: ts.Expression,
  parameters: readonly ts.ParameterDeclaration[],
): number | undefined {
  const duration = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  if (!ts.isIdentifier(duration)) return undefined;
  const index = parameters.findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === duration.text,
  );
  return index === -1 ? undefined : index;
}

function localWaitWrapperOf(
  functionNode: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  aliases: AliasSets,
): LocalWaitWrapper | undefined {
  const body = functionNode.body;
  if (!body) return undefined;

  let wrapper: LocalWaitWrapper | undefined;
  const setWrapper = (duration: ts.Expression, kind: TestWaitKind): void => {
    const parameterIndex = findDurationParameterIndex(duration, functionNode.parameters);
    if (parameterIndex !== undefined) {
      wrapper = { durationParameterIndex: parameterIndex, kind };
    }
  };
  const visit = (node: ts.Node): void => {
    if (wrapper) return;
    if (
      node !== body &&
      (ts.isArrowFunction(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (ts.isCallExpression(node)) {
      const duration = node.arguments[0];
      if (duration && isBunSleepCall(node, aliases)) setWrapper(duration, "bun-sleep");
      if (duration && isPromiseTimerCall(node, aliases)) {
        setWrapper(duration, "node-timer-promise");
      }
    } else if (ts.isNewExpression(node)) {
      promiseUsesResolvingTimeout(node, aliases, (duration) => {
        setWrapper(duration, "promise-timeout");
        return !!wrapper;
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return wrapper;
}

function collectLocalWaitWrappers(sourceFile: ts.SourceFile, aliases: AliasSets): void {
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const wrapper = localWaitWrapperOf(node, aliases);
      if (wrapper) aliases.localWaitWrappers.set(node.name.text, wrapper);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const wrapper = localWaitWrapperOf(node.initializer, aliases);
      if (wrapper) aliases.localWaitWrappers.set(node.name.text, wrapper);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function containingStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isStatement(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function hasAdjacentJustification(statement: ts.Statement, sourceFile: ts.SourceFile): boolean {
  const statementLine = sourceFile.getLineAndCharacterOfPosition(
    statement.getStart(sourceFile),
  ).line;
  if (statementLine === 0) return false;
  const precedingLineStart = sourceFile.getPositionOfLineAndCharacter(statementLine - 1, 0);
  const statementLineStart = sourceFile.getPositionOfLineAndCharacter(statementLine, 0);
  const precedingLine = sourceFile.text.slice(precedingLineStart, statementLineStart).trim();
  const match = /^\/\/\s*test-wait-justification:\s*(.+)$/.exec(precedingLine);
  return !!match?.[1]?.trim();
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function findTestWaitViolations(
  sourceText: string,
  filePath = "test.test.ts",
): TestWaitViolation[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const aliases = collectAliases(sourceFile);
  const violations: TestWaitViolation[] = [];
  const reportedStatements = new Set<number>();

  const report = (node: ts.Node, kind: TestWaitKind, description: string): void => {
    const statement = containingStatement(node);
    if (!statement || hasAdjacentJustification(statement, sourceFile)) return;
    const statementStart = statement.getStart(sourceFile);
    if (reportedStatements.has(statementStart)) return;
    reportedStatements.add(statementStart);
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      filePath,
      line: location.line + 1,
      column: location.character + 1,
      kind,
      message: `${description}; add an immediately preceding // ${JUSTIFICATION_PREFIX} <specific reason> comment`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        isBunSleepCall(node, aliases) &&
        hasNonnegativeFixedArgument(node, 0, aliases) &&
        !isRejectionOrAbortGuard(node)
      ) {
        report(node, "bun-sleep", "fixed Bun.sleep progression delay");
      } else if (
        isPromiseTimerCall(node, aliases) &&
        hasNonnegativeFixedArgument(node, 0, aliases) &&
        !isRejectionOrAbortGuard(node)
      ) {
        report(node, "node-timer-promise", "fixed node:timers/promises progression delay");
      } else {
        const wrapper = ts.isIdentifier(node.expression)
          ? aliases.localWaitWrappers.get(node.expression.text)
          : undefined;
        if (
          wrapper &&
          hasNonnegativeFixedArgument(node, wrapper.durationParameterIndex, aliases) &&
          !isRejectionOrAbortGuard(node)
        ) {
          report(node, wrapper.kind, "fixed local sleep/wait wrapper progression delay");
        } else if (
          isCallbackTimerCall(node, aliases) &&
          node.arguments[0] &&
          timerCallbackUsesWithResolvers(node.arguments[0], aliases) &&
          hasNonnegativeFixedArgument(node, 1, aliases)
        ) {
          report(node, "promise-timeout", "fixed setTimeout-backed Promise progression delay");
        }
      }
    } else if (ts.isNewExpression(node) && promiseUsesFixedResolvingTimeout(node, aliases)) {
      report(node, "promise-timeout", "fixed setTimeout-backed Promise progression delay");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export const noFixedTestWaitRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow fixed-time waits in tests unless the real timer is justified",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const violations = findTestWaitViolations(context.sourceCode.text, context.filename);
        for (const violation of violations) {
          context.report({
            loc: { line: violation.line, column: violation.column - 1 },
            message: violation.message,
          });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "lilac" },
  rules: {
    "no-fixed-test-wait": noFixedTestWaitRule,
  },
});
