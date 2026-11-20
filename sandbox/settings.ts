import { z } from "zod";

/**
 * The sandbox's fixed addresses. Every service shares one network namespace,
 * so the browser and the services reach each other at the same URLs.
 */
export const urls = {
  app: "http://localhost:5000",
  broker: "http://localhost:3000",
  clientDocument: "https://localhost:5443/clientid.jsonld",
  upstream: "http://localhost:4000",
} as const;

export const ports = { app: 5000, clientDocument: 5443, upstream: 4000 } as const;

/** The client ID the broker is registered under at the stub upstream. */
export const upstreamClientId = "solid-oidc-broker";

/** A subject the stub upstream offers to log in as. */
export type Subject = { readonly label: string; readonly subject: string };

export type Settings = {
  readonly appName: string;
  readonly appScope: string;
  readonly subjects: readonly Subject[];
  readonly upstreamClientSecret: string;
};

const Subjects = z
  .string()
  .transform((text) =>
    text
      .split(";")
      .map((pair) => pair.trim())
      .filter((pair) => pair !== "")
      .map((pair) => {
        const separator = pair.lastIndexOf("=");
        return {
          label: pair.slice(0, separator).trim(),
          subject: pair.slice(separator + 1).trim(),
        };
      }),
  )
  .pipe(z.array(z.object({ label: z.string().min(1), subject: z.string().min(1) })).min(1));

const Environment = z.object({
  SANDBOX_APP_NAME: z.string().min(1).default("Sandbox Solid App"),
  SANDBOX_APP_SCOPE: z.string().min(1).default("openid webid offline_access"),
  // Alice is in sandbox/accounts.json; the stranger is not, to show a refusal.
  SANDBOX_UPSTREAM_SUBJECTS: Subjects.default([
    { label: "Alice, who has a WebID", subject: "8c1f6d2e-0000-4000-8000-a11ce0000000" },
    { label: "A stranger, with no WebID", subject: "ffffffff-0000-4000-8000-000000000bad" },
  ]),
  // Not a secret: the sandbox runs only on this machine, and the broker's
  // compose service is given the same value.
  SANDBOX_UPSTREAM_CLIENT_SECRET: z.string().min(1).default("sandbox-only-not-a-secret"),
});

export function readSettings(environment: NodeJS.ProcessEnv): Settings {
  const parsed = Environment.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid sandbox settings:\n${z.prettifyError(parsed.error)}`);
  }
  return {
    appName: parsed.data.SANDBOX_APP_NAME,
    appScope: parsed.data.SANDBOX_APP_SCOPE,
    subjects: parsed.data.SANDBOX_UPSTREAM_SUBJECTS,
    upstreamClientSecret: parsed.data.SANDBOX_UPSTREAM_CLIENT_SECRET,
  };
}
