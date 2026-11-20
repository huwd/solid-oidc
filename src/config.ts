import { isAbsolute } from "node:path";
import { z } from "zod";

import { formatIssues, type Result, transportProblems } from "./validation.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

/** Where the upstream client secret comes from. */
export type SecretSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "value"; readonly value: string };

/** Settings read from environment variables alone, before any file is read. */
export type EnvironmentSettings = {
  /** Path to the JSON file that maps upstream accounts to WebIDs. */
  readonly accountsFile: string;
  /** Absolute path of the directory for persistent state. */
  readonly dataDir: string;
  /**
   * Fetch Client ID Documents from loopback addresses, which production
   * refuses. For the local sandbox only. See decision 0009.
   */
  readonly developmentAllowLoopbackClientIds: boolean;
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
  readonly upstream: {
    readonly clientId: string;
    readonly clientSecret: SecretSource;
    /** The upstream provider's issuer identifier, exactly as it publishes it. */
    readonly issuer: string;
  };
};

const portMax = 65_535;

const BrokerIssuer = z.url().superRefine((value, context) => {
  for (const problem of brokerIssuerProblems(value)) {
    context.addIssue({ code: "custom", message: problem });
  }
});

const UpstreamIssuer = z.url().superRefine((value, context) => {
  for (const problem of upstreamIssuerProblems(value)) {
    context.addIssue({ code: "custom", message: problem });
  }
});

const EnvironmentSchema = z.object({
  ACCOUNTS_FILE: z.string().min(1),
  DATA_DIR: z.string().refine(isAbsolute, { message: "must be an absolute path" }),
  // Only the exact words, so a typo can't turn it on.
  DEVELOPMENT_ALLOW_LOOPBACK_CLIENT_IDS: z.enum(["true", "false"]).default("false"),
  HOST: z.string().min(1).default("0.0.0.0"),
  ISSUER_URL: BrokerIssuer,
  PORT: z.coerce.number().int().min(0).max(portMax).default(3000),
  UPSTREAM_CLIENT_ID: z.string().min(1),
  UPSTREAM_CLIENT_SECRET: z.string().min(1).optional(),
  UPSTREAM_CLIENT_SECRET_FILE: z.string().min(1).optional(),
  UPSTREAM_ISSUER_URL: UpstreamIssuer,
});

/**
 * Parse and validate the environment variables. Returns every problem found,
 * so an operator can fix them in one pass. Files named by the variables are
 * read later, by `loadConfig`.
 */
export function parseEnvironment(environment: Environment): Result<EnvironmentSettings> {
  const parsed = EnvironmentSchema.safeParse(environment);
  const errors = parsed.success ? [] : formatIssues(parsed.error);
  const clientSecret = secretSource(environment);
  if (!clientSecret.ok) {
    errors.push(...clientSecret.errors);
  }
  if (!parsed.success || !clientSecret.ok) {
    return { ok: false, errors };
  }

  const variables = parsed.data;
  const settings: EnvironmentSettings = {
    accountsFile: variables.ACCOUNTS_FILE,
    dataDir: variables.DATA_DIR,
    developmentAllowLoopbackClientIds: variables.DEVELOPMENT_ALLOW_LOOPBACK_CLIENT_IDS === "true",
    host: variables.HOST,
    issuer: variables.ISSUER_URL,
    port: variables.PORT,
    upstream: {
      clientId: variables.UPSTREAM_CLIENT_ID,
      clientSecret: clientSecret.value,
      issuer: variables.UPSTREAM_ISSUER_URL,
    },
  };
  return { ok: true, value: settings };
}

// Exactly one source, so there is never a question of which one wins. Empty
// values are reported by the schema.
function secretSource(environment: Environment): Result<SecretSource> {
  const value = environment["UPSTREAM_CLIENT_SECRET"];
  const path = environment["UPSTREAM_CLIENT_SECRET_FILE"];
  if (value !== undefined && path !== undefined) {
    return {
      ok: false,
      errors: [
        "UPSTREAM_CLIENT_SECRET: set either UPSTREAM_CLIENT_SECRET or UPSTREAM_CLIENT_SECRET_FILE, not both",
      ],
    };
  }
  if (path !== undefined) {
    return { ok: true, value: { kind: "file", path } };
  }
  if (value !== undefined) {
    return { ok: true, value: { kind: "value", value } };
  }
  return {
    ok: false,
    errors: ["UPSTREAM_CLIENT_SECRET: set UPSTREAM_CLIENT_SECRET or UPSTREAM_CLIENT_SECRET_FILE"],
  };
}

// OpenID Connect Discovery 1.0, section 3: an issuer is an https URL with no
// query or fragment.
function issuerFormProblems(url: URL): string[] {
  const problems = transportProblems(url);
  if (url.search !== "" || url.hash !== "") {
    problems.push("must not have a query or fragment");
  }
  return problems;
}

// The upstream issuer must match what the provider publishes, character for
// character, so it is kept as written. Some providers' issuers end with a
// slash, so that is allowed here.
function upstreamIssuerProblems(value: string): string[] {
  // Zod still runs refinements after `z.url()` fails, and has already reported
  // that failure.
  if (!URL.canParse(value)) {
    return [];
  }
  return issuerFormProblems(new URL(value));
}

// The broker's own issuer must also be canonical. A trailing slash is rejected
// because "https://id.example" and "https://id.example/" would otherwise both
// pass, and only one of them would match the tokens.
function brokerIssuerProblems(value: string): string[] {
  if (!URL.canParse(value)) {
    return [];
  }

  const url = new URL(value);
  const problems = issuerFormProblems(url);
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
