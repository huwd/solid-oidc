import { z } from "zod";

import { formatIssues, type Result, transportProblems } from "./validation.ts";

/** An account as the upstream provider identifies it. */
export type UpstreamIdentity = {
  readonly issuer: string;
  readonly subject: string;
};

/**
 * Finds the WebID an upstream account may log in as. The login flow depends
 * only on this, so a database-backed store can replace the static one without
 * changing it. See docs/decisions/0004-static-user-mapping.md.
 */
export type AccountStore = {
  /**
   * Return the WebID mapped to exactly this issuer and subject, or undefined
   * if the account may not log in. Never match on any other claim.
   */
  findWebId(identity: UpstreamIdentity): Promise<string | undefined>;
  /**
   * Whether some account maps to this WebID. The provider checks it whenever
   * it loads an account, so removing a mapping ends that person's access.
   */
  hasWebId(webId: string): Promise<boolean>;
};

export type Account = {
  readonly upstreamIssuer: string;
  readonly upstreamSubject: string;
  readonly webId: string;
};

export type ParseAccountsOptions = {
  readonly text: string;
  /** Every account must name this issuer, the configured upstream provider. */
  readonly upstreamIssuer: string;
};

// A static file is meant for a handful of people. The bound keeps parsing
// and duplicate checks small, and a file this large is almost certainly a
// mistake.
const accountsMax = 1_000;

const WebId = z.url().superRefine((value, context) => {
  if (!URL.canParse(value)) {
    return;
  }
  for (const problem of transportProblems(new URL(value))) {
    context.addIssue({ code: "custom", message: problem });
  }
});

const AccountsFile = z.strictObject({
  accounts: z
    .array(
      z.strictObject({
        upstreamIssuer: z.string().min(1),
        upstreamSubject: z.string().min(1),
        webId: WebId,
      }),
    )
    .min(1)
    .max(accountsMax),
});

/**
 * Parse and validate the accounts file. Returns every problem found, with the
 * path of the entry each one belongs to.
 */
export function parseAccounts(options: ParseAccountsOptions): Result<readonly Account[]> {
  let json: unknown;
  try {
    json = JSON.parse(options.text);
  } catch {
    // The parser's message can quote file contents, so it is not repeated.
    return { ok: false, errors: ["is not valid JSON"] };
  }

  const parsed = AccountsFile.safeParse(json);
  if (!parsed.success) {
    const errors = formatIssues(parsed.error);
    return { ok: false, errors };
  }

  const errors = consistencyProblems({
    accounts: parsed.data.accounts,
    upstreamIssuer: options.upstreamIssuer,
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: parsed.data.accounts };
}

/** An account store backed by a fixed list, such as the accounts file. */
export function createStaticAccountStore(accounts: readonly Account[]): AccountStore {
  const webIds = indexAccounts(accounts);
  const known = new Set(accounts.map((account) => account.webId));
  return {
    findWebId: (identity) => Promise.resolve(webIds.get(identity.issuer)?.get(identity.subject)),
    hasWebId: (webId) => Promise.resolve(known.has(webId)),
  };
}

// Index by issuer, then subject, rather than by a joined string, so no choice
// of separator can make two different accounts collide.
function indexAccounts(accounts: readonly Account[]): Map<string, Map<string, string>> {
  const webIds = new Map<string, Map<string, string>>();
  for (const account of accounts) {
    const bySubject = webIds.get(account.upstreamIssuer) ?? new Map<string, string>();
    bySubject.set(account.upstreamSubject, account.webId);
    webIds.set(account.upstreamIssuer, bySubject);
  }
  return webIds;
}

function consistencyProblems(options: {
  readonly accounts: readonly Account[];
  readonly upstreamIssuer: string;
}): string[] {
  const problems: string[] = [];
  const seen = new Map<string, Set<string>>();
  for (const [index, account] of options.accounts.entries()) {
    if (account.upstreamIssuer !== options.upstreamIssuer) {
      problems.push(
        `accounts.${index}.upstreamIssuer: must equal UPSTREAM_ISSUER_URL (${options.upstreamIssuer})`,
      );
    }

    const subjects = seen.get(account.upstreamIssuer) ?? new Set<string>();
    if (subjects.has(account.upstreamSubject)) {
      problems.push(
        `accounts.${index}: duplicates an earlier entry with the same upstreamIssuer and upstreamSubject`,
      );
    }
    subjects.add(account.upstreamSubject);
    seen.set(account.upstreamIssuer, subjects);
  }
  return problems;
}
