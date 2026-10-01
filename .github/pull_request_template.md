## What and why

<!-- What changed, and why. Link the issue if there is one. -->

## Security review

- [ ] This does not widen what is auto-approved, **or** it does and the widening is exact, tested, and explained above
- [ ] Anything uncertain, missing, or failing resolves to `ask`, never `allow`
- [ ] New or changed behavior has a test for the allow case **and** a near-miss that still asks
- [ ] No real usernames, paths, emails, secrets, or private project names (`scripts/check-private-content.sh` passes)
- [ ] No new runtime dependency or network call
- [ ] `README.md` / `TRUSTED-WORKTREE-DESIGN.md` updated if behavior or settings changed
- [ ] `mise run test` passes locally
