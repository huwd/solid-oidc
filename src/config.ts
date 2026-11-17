import { z } from "zod";

/** Runtime configuration, read once at startup from environment variables. */
export type Config = {
  /** Interface the HTTP server binds to. */
  readonly host: string;
  /**
   * The issuer identifier this broker advertises to Solid clients, exactly as
   * configured. Clients compare it as a string, and it appears in tokens and
   * WebID profiles, so it must stay stable.
   */
  readonly issuer: string;
  /** TCP port the HTTP server listens on. Zero picks a free port. */
  readonly port: number;
};

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly errors: readonly string[] };

export type Environment = Readonly<Record<string, string | undefined>>;

const portMax = 65_535;

// Plain HTTP is allowed only for loopback hosts, so a development issuer can
// run without TLS but a deployed one cannot.
const loopbackHostnames: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

const Issuer = z.url().superRefine((value, context) => {
  for (const problem of issuerProblems(value)) {
    context.addIssue({ code: "custom", message: problem });
  }
});

const EnvironmentSchema = z.object({
  HOST: z.string().min(1).default("0.0.0.0"),
  ISSUER_URL: Issuer,
  PORT: z.coerce.number().int().min(0).max(portMax).default(3000),
});

/**
 * Parse and validate configuration from environment variables. Returns every
 * problem found, so an operator can fix them in one pass.
 */
export function parseConfig(environment: Environment): ConfigResult {
  const parsed = EnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return { ok: false, errors };
  }

  const config: Config = {
    host: parsed.data.HOST,
    issuer: parsed.data.ISSUER_URL,
    port: parsed.data.PORT,
  };
  return { ok: true, config };
}

// OpenID Connect Discovery 1.0, section 3: the issuer is an https URL with no
// query or fragment. Clients compare issuers as exact strings, so the value
// must also be canonical. A trailing slash is rejected because
// "https://id.example" and "https://id.example/" would otherwise both pass,
// and only one of them would match the tokens.
function issuerProblems(value: string): string[] {
  // Zod still runs refinements after `z.url()` fails, and has already reported
  // that failure.
  if (!URL.canParse(value)) {
    return [];
  }

  const url = new URL(value);
  const problems: string[] = [];
  const isLoopback = loopbackHostnames.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    problems.push("must use https, except on a loopback host");
  }
  if (url.search !== "" || url.hash !== "") {
    problems.push("must not have a query or fragment");
  }
  if (url.username !== "" || url.password !== "") {
    problems.push("must not contain credentials");
  }
  if (value.endsWith("/")) {
    problems.push("must not end with a slash");
  }
  // Only suggest a canonical form for an otherwise valid issuer, so the
  // suggestion is one the operator can use.
  if (problems.length === 0 && value !== canonicalIssuer(url)) {
    problems.push(`must be written in canonical form: ${canonicalIssuer(url)}`);
  }
  return problems;
}

// The WHATWG URL parser gives a bare origin the path "/", which an issuer
// leaves out.
function canonicalIssuer(url: URL): string {
  return url.pathname === "/" ? url.href.slice(0, -1) : url.href;
}
