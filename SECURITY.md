# Security policy

## Reporting a vulnerability

Report privately through GitHub's
[security advisory form](https://github.com/dscanavall11/ai-lang/security/advisories/new).
Please do not open a public issue for a vulnerability.

Expect an acknowledgement within a week. The project is maintained in spare
time, so a fix may take longer than that — the advisory thread will say where
things stand.

## What counts

AI-Lang is a compiler. The interesting attack surface is what it *emits*, not
what it runs:

- **Generated code that is exploitable** — an injection in a generated query, a
  missing authorization check the source declared, a secret written into an
  artifact. This is the highest-value class of report.
- **Generated infrastructure that is unsafe by default** — an open security
  group, a public bucket, a credential in a template.
- **Compiler crashes on hostile input** are bugs, not vulnerabilities: the
  compiler reads source you already trust enough to build.

## What the compiler promises

- It never writes a secret **value** into any artifact. `.ail` sources declare
  secrets by name only; generated code references them through the environment.
  If you find a literal value in generated output, that is a vulnerability.
- It makes no network requests and executes nothing during compilation.
- It generates no code from a source construct that does not exist — if the
  compiler cannot express something, it says so rather than improvising.

## Supported versions

Pre-1.0. Only `main` is supported; there are no backported fixes yet.
