import path from "node:path";

import ts from "typescript-codegen";

import type { WorkspaceArchitecture } from "./manifest.ts";
import { isProductionFileName } from "./source-policy.ts";

export interface WorkspaceProgram {
  readonly root: string;
  readonly program: ts.Program;
}

export type WorkspaceProgramFactory = (
  repositoryRoot: string,
  workspace: WorkspaceArchitecture,
) => WorkspaceProgram;

interface LoadedWorkspaceProgram extends WorkspaceProgram {
  readonly parsed: ts.ParsedCommandLine;
}

const RULE_CRITICAL_PACKAGES = ["zod", "better-result"] as const;

function packageMatches(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function moduleSpecifier(node: ts.Node): ts.StringLiteralLike | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      ? node.moduleSpecifier
      : undefined;
  }
  if (ts.isImportEqualsDeclaration(node)) {
    const reference = node.moduleReference;
    return ts.isExternalModuleReference(reference) &&
      reference.expression &&
      ts.isStringLiteralLike(reference.expression)
      ? reference.expression
      : undefined;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1
  ) {
    const argument = node.arguments[0];
    return argument && ts.isStringLiteralLike(argument) ? argument : undefined;
  }
  return undefined;
}

function architectureResolutionDiagnostics(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
): readonly ts.Diagnostic[] {
  const criticalPackages = new Set<string>(RULE_CRITICAL_PACKAGES);
  for (const output of workspace.compatibilityOutputs) {
    if (output.sink.kind === "external") criticalPackages.add(output.sink.package);
  }
  for (const logger of workspace.structuredLoggers) {
    if (logger.sink.kind === "external") criticalPackages.add(logger.sink.package);
  }
  for (const formatter of workspace.taggedErrorFormatters) {
    if (formatter.kind === "external") criticalPackages.add(formatter.package);
  }
  for (const adapter of workspace.openProtocolAdapters) {
    criticalPackages.add(adapter.externalProtocol.package);
  }
  const localSinkModules = new Set(
    [
      ...workspace.compatibilityOutputs.map((output) => output.sink),
      ...workspace.structuredLoggers.map((logger) => logger.sink),
      ...workspace.taggedErrorFormatters,
    ].flatMap((sink) => (sink.kind === "local" ? [sink.module] : [])),
  );
  const checker = program.getTypeChecker();
  const diagnostics: ts.Diagnostic[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !isProductionFileName(sourceFile.fileName, workspaceRoot)) {
      continue;
    }
    const sourceModule = path
      .relative(workspaceRoot, sourceFile.fileName)
      .split(path.sep)
      .join("/");
    const validateAllImports = localSinkModules.has(sourceModule);
    const visit = (node: ts.Node): void => {
      const specifier = moduleSpecifier(node);
      if (
        specifier &&
        (validateAllImports ||
          [...criticalPackages].some((packageName) =>
            packageMatches(specifier.text, packageName),
          )) &&
        !checker.getSymbolAtLocation(specifier)
      ) {
        diagnostics.push({
          category: ts.DiagnosticCategory.Error,
          code: 2307,
          file: sourceFile,
          start: specifier.getStart(sourceFile),
          length: specifier.getWidth(sourceFile),
          messageText: `Cannot find module '${specifier.text}' or its corresponding type declarations.`,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return diagnostics;
}

function failOnArchitectureBlockingDiagnostics(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  parsed: ts.ParsedCommandLine,
  program: ts.Program,
): void {
  const syntacticDiagnostics = program
    .getSourceFiles()
    .filter((sourceFile) => isProductionFileName(sourceFile.fileName, workspaceRoot))
    .flatMap((sourceFile) => program.getSyntacticDiagnostics(sourceFile));
  const diagnostics: ts.Diagnostic[] = [
    ...parsed.errors,
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...syntacticDiagnostics,
    ...architectureResolutionDiagnostics(workspace, workspaceRoot, program),
  ];
  const unique = [
    ...new Map(
      diagnostics.map((diagnostic) => [
        `${diagnostic.file?.fileName ?? "<config>"}:${diagnostic.start ?? 0}:${diagnostic.code}`,
        diagnostic,
      ]),
    ).values(),
  ];
  if (unique.length === 0) return;
  const formatted = ts.formatDiagnosticsWithColorAndContext(unique, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => workspaceRoot,
    getNewLine: () => ts.sys.newLine,
  });
  throw new Error(`TS6 cannot safely analyze ${workspace.name}:\n${formatted}`);
}

function loadWorkspaceProgram(
  repositoryRoot: string,
  workspace: WorkspaceArchitecture,
): LoadedWorkspaceProgram {
  const tsconfig = path.resolve(repositoryRoot, workspace.tsconfig);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfig,
    { noEmit: true },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        throw new Error(`Cannot load ${tsconfig}: ${message}`);
      },
    },
  );
  if (!parsed) throw new Error(`Cannot load ${tsconfig}`);

  const root = path.resolve(repositoryRoot, workspace.root);
  const rootNames = parsed.fileNames.filter(
    (fileName) => /\.d\.[cm]?ts$/u.test(fileName) || isProductionFileName(fileName, root),
  );
  const program = ts.createProgram({ rootNames, options: parsed.options });
  return { root, parsed, program };
}

function validateLoadedWorkspaceProgram(
  workspace: WorkspaceArchitecture,
  loaded: LoadedWorkspaceProgram,
): WorkspaceProgram {
  failOnArchitectureBlockingDiagnostics(workspace, loaded.root, loaded.parsed, loaded.program);
  return { root: loaded.root, program: loaded.program };
}

export function createWorkspaceProgram(
  repositoryRoot: string,
  workspace: WorkspaceArchitecture,
): WorkspaceProgram {
  return validateLoadedWorkspaceProgram(workspace, loadWorkspaceProgram(repositoryRoot, workspace));
}

export function createCachingWorkspaceProgramFactory(): WorkspaceProgramFactory {
  const programs = new Map<string, LoadedWorkspaceProgram>();
  return (repositoryRoot, workspace) => {
    const key = `${path.resolve(repositoryRoot, workspace.root)}\0${path.resolve(repositoryRoot, workspace.tsconfig)}`;
    let loaded = programs.get(key);
    if (!loaded) {
      loaded = loadWorkspaceProgram(repositoryRoot, workspace);
      programs.set(key, loaded);
    }
    return validateLoadedWorkspaceProgram(workspace, loaded);
  };
}
