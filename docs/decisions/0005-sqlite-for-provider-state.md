# 0005. Store provider state in SQLite through node:sqlite

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-17
- **Recorded:** 2026-11-17
- **Discussion:** Repository set-up, 17 November 2026 (no issue)

## Summary

The broker keeps the state `oidc-provider` needs (sessions, grants, authorisation codes, refresh tokens and cached client documents) in a SQLite database on a mounted volume.
It uses Node's built-in `node:sqlite` module, so there is no native add-on to compile.
SQLite needs no extra service on the NAS, and one file is easy to back up and restore.

## Context

`oidc-provider` stores short-lived and long-lived state through an adapter interface.
Its in-memory adapter loses everything on restart, which logs every user out and invalidates refresh tokens.
The broker is a single container with a few users, deployed on a Synology NAS that is short on I/O during its backup window.

## Options considered

### SQLite through node:sqlite (chosen)

One file on a volume, no extra container, and the built-in module avoids a native dependency such as `better-sqlite3`.
Write-ahead logging allows concurrent reads while writing.
A single file is simple to back up, but must be copied consistently, for example with SQLite's backup command rather than a plain file copy during writes.

It limits the broker to one instance. That is acceptable for this deployment.

### Redis

Fits `oidc-provider`'s expiring records well, and the documentation includes an example adapter.
It adds a service to run, secure and back up. Composer already runs Redis for other stacks, but sharing it would couple the identity provider to their availability.

### PostgreSQL

Strong for many users and several instances, but more to operate than this deployment needs.

### Files or memory

Memory loses state on restart.
Hand-written file storage would mean solving locking and expiry without gaining anything over SQLite.

## Decision

Store `oidc-provider` state in a SQLite database at a configurable path on a mounted volume, accessed through `node:sqlite`.
Expired records are removed on a schedule.

## Consequences

- One instance only. Running more than one needs a shared database and a new record.
- Backups must include the database and the signing keys, using a consistent copy. Test a restore before relying on it.
- `node:sqlite` is newer than the established third-party modules. Check its stability status on each Node upgrade.
- The same database can later hold accounts if [0004](0004-static-user-mapping.md) is superseded.
