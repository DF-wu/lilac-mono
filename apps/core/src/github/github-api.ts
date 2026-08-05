import { createAppAuth } from "@octokit/auth-app";
import { Panic, Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import { env } from "@stanley2058/lilac-utils";

import {
  deriveApiBaseUrl,
  readGithubAppPrivateKeyPemResult,
  readGithubAppSecret,
} from "./github-app";
import {
  getGithubUserLoginOrNull as getGithubUserLoginFromAuth,
  getGithubViewerLoginOrNull as getGithubViewerLoginByTokenOrNull,
  resolveGithubViewerLoginOrThrow,
  getGithubUserAuthOrNull,
  getPreferredGithubAuthOrNull,
  getPreferredGithubAuthResult,
  type GithubAuthFailed,
} from "./github-auth";

type GithubApiCtx = {
  apiBaseUrl: string;
  token: string;
};

type GithubRequestBody = Readonly<Record<string, string | number>>;

const githubIdSchema = z.object({ id: z.number().int() });
const githubIssueCommentSchema = z.object({
  id: z.number().int(),
  user: z.object({ login: z.string().optional(), id: z.number().int().optional() }).optional(),
  body: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  html_url: z.string().optional(),
  performed_via_github_app: z
    .object({ id: z.number().int().optional(), slug: z.string().optional() })
    .nullable()
    .optional(),
});
const githubIssueSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string().optional(),
  pull_request: z.object({}).passthrough().optional(),
  user: z.object({ login: z.string().optional(), id: z.number().int().optional() }).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
const githubReactionSchema = z.object({
  id: z.number().int(),
  content: z.string(),
  user: z.object({ login: z.string().optional(), id: z.number().int().optional() }).optional(),
});
const githubPullRequestSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string().optional(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string() }),
});
const githubAppSchema = z.object({ slug: z.string().min(1) });

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

function githubApiError(input: {
  status: number;
  statusText: string;
  path: string;
  body: string;
}): GithubApiError {
  return new GithubApiError(
    input.status,
    input.path,
    `GitHub API error (${input.status} ${input.statusText}) at ${input.path}${input.body ? `: ${input.body}` : ""}`,
  );
}

function headers(token: string, extra?: Record<string, string>): HeadersInit {
  return {
    "User-Agent": "lilac",
    Accept: "application/vnd.github+json, application/vnd.github.squirrel-girl-preview+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `token ${token}`,
    ...extra,
  };
}

async function captureGithubApiExternal<T, E>(
  run: () => Promise<T>,
  mapError: (cause: unknown) => E,
): Promise<ResultType<T, E>> {
  try {
    return Result.ok(await run());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(mapError(cause));
  }
}

async function captureGithubResponseText(response: Response): Promise<ResultType<string, Error>> {
  return captureGithubApiExternal(
    () => response.text(),
    (cause) => new Error("GitHub error response body unavailable", { cause }),
  );
}

async function ctxResult(): Promise<ResultType<GithubApiCtx, GithubAuthFailed | GithubApiError>> {
  const auth = await getPreferredGithubAuthResult({ dataDir: env.dataDir });
  if (auth.status === "error") return Result.err(auth.error);
  if (!auth.value) {
    return Result.err(
      new GithubApiError(
        401,
        "auth",
        "GitHub auth not configured. Configure outbound user auth or GitHub App auth.",
      ),
    );
  }
  return Result.ok({ apiBaseUrl: auth.value.apiBaseUrl, token: auth.value.token });
}

async function ctx(): Promise<GithubApiCtx> {
  return adaptGithubApiResultToHost(await ctxResult());
}

async function githubFetchJsonResult<T>(input: {
  apiBaseUrl: string;
  token: string;
  path: string;
  method?: string;
  body?: GithubRequestBody;
  schema: z.ZodType<T>;
}): Promise<ResultType<T, GithubApiError>> {
  const url = `${input.apiBaseUrl.replace(/\/$/u, "")}${input.path}`;
  const fetched = await captureGithubApiExternal(
    () =>
      fetch(url, {
        method: input.method ?? "GET",
        headers: headers(
          input.token,
          input.body ? { "Content-Type": "application/json" } : undefined,
        ),
        body: input.body ? JSON.stringify(input.body) : undefined,
      }),
    () => new GithubApiError(503, input.path, `GitHub request failed at ${input.path}`),
  );
  if (fetched.status === "error") return Result.err(fetched.error);
  const res = fetched.value;
  if (!res.ok) {
    const body = await captureGithubResponseText(res);
    return Result.err(
      githubApiError({
        status: res.status,
        statusText: res.statusText,
        path: input.path,
        body: body.status === "ok" ? body.value : "",
      }),
    );
  }
  const body = await captureGithubApiExternal(
    async (): Promise<unknown> => await res.json(),
    () => new GithubApiError(502, input.path, `GitHub API response unreadable at ${input.path}`),
  );
  if (body.status === "error") return Result.err(body.error);
  const decoded = input.schema.safeParse(body.value);
  if (!decoded.success) {
    return Result.err(
      new GithubApiError(
        502,
        input.path,
        `GitHub API returned an invalid response at ${input.path}`,
      ),
    );
  }
  return Result.ok(decoded.data);
}

function adaptGithubApiResultToHost<T>(
  result: ResultType<T, GithubApiError | GithubAuthFailed>,
): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

async function githubFetchJson<T>(
  input: Parameters<typeof githubFetchJsonResult<T>>[0],
): Promise<T> {
  return adaptGithubApiResultToHost(await githubFetchJsonResult(input));
}

async function githubFetchNoBodyResult(input: {
  apiBaseUrl: string;
  token: string;
  path: string;
  method: string;
}): Promise<ResultType<void, GithubApiError>> {
  const url = `${input.apiBaseUrl.replace(/\/$/u, "")}${input.path}`;
  const fetched = await captureGithubApiExternal(
    () =>
      fetch(url, {
        method: input.method,
        headers: headers(input.token),
      }),
    () => new GithubApiError(503, input.path, `GitHub request failed at ${input.path}`),
  );
  if (fetched.status === "error") return Result.err(fetched.error);
  const res = fetched.value;
  if (!res.ok) {
    const body = await captureGithubResponseText(res);
    return Result.err(
      githubApiError({
        status: res.status,
        statusText: res.statusText,
        path: input.path,
        body: body.status === "ok" ? body.value : "",
      }),
    );
  }
  return Result.ok(undefined);
}

async function githubFetchNoBody(
  input: Parameters<typeof githubFetchNoBodyResult>[0],
): Promise<void> {
  adaptGithubApiResultToHost(await githubFetchNoBodyResult(input));
}

export async function addEyesReactionToIssue(input: {
  owner: string;
  repo: string;
  issueNumber: number;
}): Promise<number> {
  const c = await ctx();
  const out = await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/reactions`,
    method: "POST",
    body: { content: "eyes" },
    schema: githubIdSchema,
  });
  return out.id;
}

export async function addEyesReactionToIssueComment(input: {
  owner: string;
  repo: string;
  commentId: number;
}): Promise<number> {
  const c = await ctx();
  const out = await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}/reactions`,
    method: "POST",
    body: { content: "eyes" },
    schema: githubIdSchema,
  });
  return out.id;
}

export async function deleteIssueReactionById(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  reactionId: number;
}): Promise<void> {
  const c = await ctx();
  await githubFetchNoBody({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/reactions/${input.reactionId}`,
    method: "DELETE",
  });
}

export async function deleteIssueCommentReactionById(input: {
  owner: string;
  repo: string;
  commentId: number;
  reactionId: number;
}): Promise<void> {
  const c = await ctx();
  await githubFetchNoBody({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}/reactions/${input.reactionId}`,
    method: "DELETE",
  });
}

export async function createIssueComment(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<{ id: number; html_url?: string }> {
  const c = await ctx();
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`,
    method: "POST",
    body: { body: input.body },
    schema: githubIssueCommentSchema.pick({ id: true, html_url: true }),
  });
}

export async function getIssueComment(input: {
  owner: string;
  repo: string;
  commentId: number;
}): Promise<{
  id: number;
  user?: { login?: string; id?: number };
  body?: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  performed_via_github_app?: { id?: number; slug?: string } | null;
}> {
  const c = await ctx();
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}`,
    schema: githubIssueCommentSchema,
  });
}

export async function editIssueComment(input: {
  owner: string;
  repo: string;
  commentId: number;
  body: string;
}): Promise<void> {
  const c = await ctx();
  await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}`,
    method: "PATCH",
    body: { body: input.body },
    schema: githubIssueCommentSchema,
  });
}

export async function deleteIssueComment(input: {
  owner: string;
  repo: string;
  commentId: number;
}): Promise<void> {
  const c = await ctx();
  await githubFetchNoBody({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}`,
    method: "DELETE",
  });
}

export async function getIssue(input: { owner: string; repo: string; number: number }): Promise<{
  title: string;
  body: string | null;
  html_url?: string;
  pull_request?: unknown;
  user?: { login?: string; id?: number };
  created_at?: string;
  updated_at?: string;
}> {
  const c = await ctx();
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.number}`,
    schema: githubIssueSchema,
  });
}

export async function listIssueComments(input: {
  owner: string;
  repo: string;
  number: number;
  limit: number;
  page?: number;
}): Promise<
  Array<{
    id: number;
    user?: { login?: string; id?: number };
    body?: string;
    created_at?: string;
    updated_at?: string;
    html_url?: string;
    performed_via_github_app?: { id?: number; slug?: string } | null;
  }>
> {
  const c = await ctx();
  const perPage = Math.min(Math.max(input.limit, 1), 100);
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.number}/comments?per_page=${perPage}&page=${Math.max(1, input.page ?? 1)}`,
    schema: z.array(githubIssueCommentSchema),
  });
}

export type GithubReaction = {
  id: number;
  content: string;
  user?: { login?: string; id?: number };
};

export async function createIssueReaction(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
}): Promise<{ id: number }> {
  const c = await ctx();
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/reactions`,
    method: "POST",
    body: { content: input.content },
    schema: githubIdSchema,
  });
}

export async function createIssueCommentReaction(input: {
  owner: string;
  repo: string;
  commentId: number;
  content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
}): Promise<{ id: number }> {
  const c = await ctx();
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}/reactions`,
    method: "POST",
    body: { content: input.content },
    schema: githubIdSchema,
  });
}

export async function listIssueReactions(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  limit: number;
}): Promise<GithubReaction[]> {
  const c = await ctx();
  const perPage = Math.min(Math.max(input.limit, 1), 100);
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/reactions?per_page=${perPage}`,
    schema: z.array(githubReactionSchema),
  });
}

export async function listIssueCommentReactions(input: {
  owner: string;
  repo: string;
  commentId: number;
  limit: number;
}): Promise<GithubReaction[]> {
  const c = await ctx();
  const perPage = Math.min(Math.max(input.limit, 1), 100);
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}/reactions?per_page=${perPage}`,
    schema: z.array(githubReactionSchema),
  });
}

export async function getPullRequest(input: {
  owner: string;
  repo: string;
  number: number;
}): Promise<{
  title: string;
  body: string | null;
  html_url?: string;
  head: { sha: string; ref: string };
  base: { ref: string };
}> {
  const c = await ctx();
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/pulls/${input.number}`,
    schema: githubPullRequestSchema,
  });
}

export async function getGithubUserLoginOrNull(): Promise<string | null> {
  return await getGithubUserLoginFromAuth({ dataDir: env.dataDir });
}

export async function getConfiguredGithubAppIdOrNull(): Promise<number | null> {
  return (await readGithubAppSecret(env.dataDir))?.appId ?? null;
}

export type GithubAuthoritativeActor =
  | { source: "app"; appId: number }
  | { source: "user"; login: string };

export async function getPreferredGithubAuthoritativeActorOrNull(
  params: { dataDir: string } = { dataDir: env.dataDir },
): Promise<GithubAuthoritativeActor | null> {
  const user = await getGithubUserAuthOrNull(params);
  if (user) {
    const login = await resolveGithubViewerLoginOrThrow({
      apiBaseUrl: user.apiBaseUrl,
      token: user.token,
    });
    return { source: "user", login: login.toLowerCase() };
  }
  const app = await readGithubAppSecret(params.dataDir);
  return app ? { source: "app", appId: app.appId } : null;
}

export async function getPreferredGithubActorLoginOrNull(): Promise<string | null> {
  const auth = await getPreferredGithubAuthOrNull({ dataDir: env.dataDir });
  if (!auth) return null;

  if (auth.source === "user") {
    return await getGithubViewerLoginByTokenOrNull({
      apiBaseUrl: auth.apiBaseUrl,
      token: auth.token,
    });
  }

  const slug = await getGithubAppSlugOrNull();
  if (!slug) return null;
  return `${slug}[bot]`;
}

export async function getGithubAppSlugOrNull(): Promise<string | null> {
  const secret = await readGithubAppSecret(env.dataDir);
  if (!secret) return null;

  const apiBaseUrl = deriveApiBaseUrl({ host: secret.host, apiBaseUrl: secret.apiBaseUrl });
  const privateKey = await readGithubAppPrivateKeyPemResult(secret);
  if (privateKey.status === "error") return null;

  const authenticated = await captureGithubApiExternal(
    async () => {
      const auth = createAppAuth({
        appId: secret.appId,
        privateKey: privateKey.value,
        baseUrl: apiBaseUrl,
      });
      return await auth({ type: "app" });
    },
    (cause) => new Error("GitHub App authentication failed", { cause }),
  );
  if (authenticated.status === "error") return null;
  const jwt = authenticated.value;
  if (!jwt || typeof jwt.token !== "string" || jwt.token.length === 0) {
    return null;
  }

  const fetched = await captureGithubApiExternal(
    () =>
      fetch(`${apiBaseUrl.replace(/\/$/u, "")}/app`, {
        headers: {
          "User-Agent": "lilac",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${jwt.token}`,
        },
      }),
    (cause) => new Error("GitHub App request failed", { cause }),
  );
  if (fetched.status === "error") return null;
  const res = fetched.value;
  if (!res.ok) return null;
  const body = await captureGithubAppResponse(res);
  return body.status === "ok" && body.value.success ? body.value.data.slug : null;
}

async function captureGithubAppResponse(
  response: Response,
): Promise<ResultType<ReturnType<typeof githubAppSchema.safeParse>, Error>> {
  return captureGithubApiExternal(
    async () => githubAppSchema.safeParse(await response.json()),
    (cause) => new Error("GitHub App response unavailable", { cause }),
  );
}
