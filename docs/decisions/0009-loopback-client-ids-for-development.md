# 0009. Allow loopback Client ID Documents only behind a development setting

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-20
- **Recorded:** 2026-11-20
- **Discussion:** [#17](https://github.com/huwd/solid-oidc/issues/17)

## Summary

The broker refuses to fetch a Client ID Document from a private or loopback address, so an app's `client_id` can't be used to reach services on the broker's own network.
The local sandbox needs exactly that: its stub app serves its document on `localhost`.
A setting, `DEVELOPMENT_ALLOW_LOOPBACK_CLIENT_IDS`, lifts the refusal for loopback hosts only. It is off by default, accepts only `true` or `false`, and the broker logs a warning at startup while it is on.

## Context

[Decision 0008](0008-solid-oidc-through-oidc-provider-features.md) leaves fetching Client ID Documents to `oidc-provider`.
Its fetch accepts HTTPS URLs only, and passes a connection dispatcher that refuses connections to private, loopback and other special-use addresses. That refusal stops server-side request forgery, and is essential in production.

The sandbox in [#17](https://github.com/huwd/solid-oidc/issues/17) runs the broker and its stubs on one machine. Every service shares one network namespace and reaches the others at `localhost`, so the browser and the services agree on every URL. The Client ID Document of the stub app is therefore on `localhost`, and the broker refuses it.

The automated tests don't need any of this, because they inject `fetch` and serve documents from memory.

## Options considered

### A development setting that lifts the refusal for loopback hosts only (chosen)

When the setting is on, the broker's fetch drops `oidc-provider`'s dispatcher for a URL whose host is `localhost`, `127.0.0.1` or `[::1]`. Every other URL keeps the protection, including private network addresses.

- The sandbox works with the real broker image, unchanged.
- The name of the setting says it is for development, it is off unless set to exactly `true`, and the broker warns at startup while it is on.
- HTTPS is still required, so the sandbox needs its own certificate. The sandbox creates one on first start.
- If the setting is turned on in production, an app could make the broker fetch from services on the broker's own host. The name, the warning and the README all say never to do this.

### Serve the sandbox document on a public address

- No change to the broker.
- The sandbox would depend on the internet and on a host outside the repository, and the document's redirect URI would still have to be `localhost`.

### Resolve Client ID Documents in the broker's own code for the sandbox

- Avoids changing how `oidc-provider` fetches.
- It would be a second fetching path, used only in development, so the sandbox would no longer test what production runs.

## Decision

The broker accepts `DEVELOPMENT_ALLOW_LOOPBACK_CLIENT_IDS`. Set to `true`, it lets the broker fetch Client ID Documents from `localhost`, `127.0.0.1` and `[::1]`. It is `false` by default, any value other than `true` or `false` is refused at startup, and the broker logs a warning while it is on. Only the compose file for the sandbox sets it.

## Consequences

- Logins in the sandbox use the same fetch, cache and validation as production, apart from the address check.
- Production configuration must never set this variable. A deployment review should check for it.
- A host name that resolves to loopback but is not one of the three names, such as `localhost.example.test`, is still refused. The sandbox uses `localhost`.
