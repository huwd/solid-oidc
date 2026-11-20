import type { z } from "zod";

/**
 * The outcome of an operation whose failure is expected, such as validating
 * operator-supplied configuration. Failures carry every problem found, so they
 * can all be fixed in one pass.
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

// Plain HTTP is allowed only for loopback hosts, so a development setup can
// run without TLS but a deployed one cannot.
const loopbackHostnames: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The short code of a Node system error, such as ENOENT or EACCES. It says
 * what to fix without repeating anything from the file involved.
 */
export function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "unknown error";
}

/** Format schema issues as "path: message", one per problem. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

/**
 * Problems with how a URL may be reached: it must use HTTPS (or HTTP on a
 * loopback host) and must not embed credentials. Shared by issuer URLs and
 * WebIDs, which add their own rules on top.
 */
export function transportProblems(url: URL): string[] {
  const problems: string[] = [];
  const isLoopback = loopbackHostnames.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    problems.push("must use https, except on a loopback host");
  }
  if (url.username !== "" || url.password !== "") {
    problems.push("must not contain credentials");
  }
  return problems;
}
