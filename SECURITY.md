# Security policy

This plugin decides which commands an AI coding agent may run without asking,
so a bug in it is a security issue.

## Reporting a vulnerability

Please report privately through GitHub's
["Report a vulnerability"](../../security/advisories/new) form on this
repository. Do not open a public issue for a bypass or a way to widen what is
auto-approved.

## Supported versions

Only the latest released version receives fixes.

## Release integrity

Releases are immutable: once published, a tag and its assets cannot be changed
or deleted. Each release tarball carries a build provenance attestation, which
you can verify with `gh attestation verify <tarball> --repo <owner>/<repo>`,
and a `.sha256` file.
