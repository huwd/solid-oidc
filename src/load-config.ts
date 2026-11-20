import { type AccountStore, createStaticAccountStore, parseAccounts } from "./accounts.ts";
import { type Environment, parseEnvironment, type SecretSource } from "./config.ts";
import { errorCode, type Result } from "./validation.ts";

/** Runtime configuration: environment variables plus the files they name. */
export type Config = {
  readonly accounts: AccountStore;
  readonly dataDir: string;
  readonly host: string;
  readonly issuer: string;
  readonly port: number;
  readonly upstream: {
    readonly clientId: string;
    /** Never log this. */
    readonly clientSecret: string;
    readonly issuer: string;
  };
};

/** Reads a whole file as UTF-8 text. Injected so tests need no real files. */
export type ReadTextFile = (path: string) => Promise<string>;

export type LoadConfigOptions = {
  readonly environment: Environment;
  readonly readTextFile: ReadTextFile;
};

/**
 * Read and validate all configuration at startup: the environment, the
 * upstream client secret file if one is named, and the accounts file.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<Result<Config>> {
  const parsed = parseEnvironment(options.environment);
  if (!parsed.ok) {
    return parsed;
  }

  const settings = parsed.value;
  const [clientSecret, accounts] = await Promise.all([
    resolveSecret({ readTextFile: options.readTextFile, source: settings.upstream.clientSecret }),
    loadAccounts({
      path: settings.accountsFile,
      readTextFile: options.readTextFile,
      upstreamIssuer: settings.upstream.issuer,
    }),
  ]);
  if (!clientSecret.ok || !accounts.ok) {
    const errors = [
      ...(clientSecret.ok ? [] : clientSecret.errors),
      ...(accounts.ok ? [] : accounts.errors),
    ];
    return { ok: false, errors };
  }

  const config: Config = {
    accounts: accounts.value,
    dataDir: settings.dataDir,
    host: settings.host,
    issuer: settings.issuer,
    port: settings.port,
    upstream: {
      clientId: settings.upstream.clientId,
      clientSecret: clientSecret.value,
      issuer: settings.upstream.issuer,
    },
  };
  return { ok: true, value: config };
}

async function resolveSecret(options: {
  readonly readTextFile: ReadTextFile;
  readonly source: SecretSource;
}): Promise<Result<string>> {
  if (options.source.kind === "value") {
    return { ok: true, value: options.source.value };
  }

  const variable = "UPSTREAM_CLIENT_SECRET_FILE";
  const text = await readFileResult({
    path: options.source.path,
    readTextFile: options.readTextFile,
    variable,
  });
  if (!text.ok) {
    return text;
  }
  // Secret files written by `echo` or an editor usually end with a newline,
  // which is not part of the secret.
  const secret = text.value.replace(/\r?\n$/, "");
  if (secret === "") {
    return { ok: false, errors: [`${variable}: ${options.source.path} is empty`] };
  }
  return { ok: true, value: secret };
}

async function loadAccounts(options: {
  readonly path: string;
  readonly readTextFile: ReadTextFile;
  readonly upstreamIssuer: string;
}): Promise<Result<AccountStore>> {
  const variable = "ACCOUNTS_FILE";
  const text = await readFileResult({ ...options, variable });
  if (!text.ok) {
    return text;
  }

  const accounts = parseAccounts({ text: text.value, upstreamIssuer: options.upstreamIssuer });
  if (!accounts.ok) {
    return { ok: false, errors: accounts.errors.map((error) => `${variable}: ${error}`) };
  }
  return { ok: true, value: createStaticAccountStore(accounts.value) };
}

async function readFileResult(options: {
  readonly path: string;
  readonly readTextFile: ReadTextFile;
  readonly variable: string;
}): Promise<Result<string>> {
  try {
    return { ok: true, value: await options.readTextFile(options.path) };
  } catch (error) {
    return {
      ok: false,
      errors: [`${options.variable}: could not read ${options.path} (${errorCode(error)})`],
    };
  }
}
