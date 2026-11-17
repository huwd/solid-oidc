# 0000. Record decisions in lightweight decision records

- **Status:** Accepted
- **Decided by:** @huwd
- **Decided:** 2026-11-17
- **Recorded:** 2026-11-17
- **Discussion:** Repository set-up, 17 November 2026 (no issue)

## Summary

Significant choices about the broker are recorded in short Markdown files, so their reasons stay easy to find as the code changes.
Each record explains the choice, the alternatives considered and when the decision was made.
The format matches the one already used in the author's laptop configuration repository, so records read the same across projects.

## Context

The broker starts with several choices that are expensive to reverse: the language, the storage engine, how users map to WebIDs and how the image is published.
An issuer is security configuration. Its identifier ends up in tokens and WebID profiles, and the reasons behind its behaviour need to outlive the conversation that set them.

One person, working with coding agents, makes most decisions.
The form must suit writing records without a team to review them.

## Options considered

### Nygard records with a summary, options and two dates (chosen)

Michael Nygard's format (title, status, context, decision and consequences) with three additions taken from the [declarative laptop repository's record 0000](https://huwd.github.io/declarative_laptop/decisions/0000-record-decisions/):

- a short, plain-language summary
- an "Options considered" section, because the losing options are often the most useful part
- separate "Decided" and "Recorded" dates

Using the same format across repositories means one set of habits and one template.

### MADR 4

A fuller template with decision drivers, pros and cons, and confirmation steps.
It serves teams well, but filling in every section for a one-person project makes records slower to write without making them more useful.

### No records

Rely on commit messages and pull requests.
These are hard to find again, and they explain a line of code rather than the alternatives that lost.

## Decision

Record significant decisions as numbered Markdown files in `docs/decisions/`, using [`template.md`](template.md).
[`README.md`](README.md) covers when and how to write one, and indexes them.
Records name who decided in a "Decided by" line, by GitHub handle, and avoid first-person pronouns.

## Consequences

- The reasons for early choices, such as static user mapping, survive into the later work that revisits them.
- Changing a decision means writing a new record and marking the old one superseded.
- Records add some writing for each significant change.
  The "When to write one" section keeps that effort for decisions that need it.
