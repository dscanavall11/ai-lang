<!-- Keep this short. Delete the sections that do not apply. -->

## What this changes

## Why

<!-- If it fixes an issue: Fixes #123 -->

## Checks

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] `node packages/cli/dist/bin.js check examples` still reports no errors

## If it touches the language

- [ ] `docs/language-reference.md` updated in this PR
- [ ] All five backends lower the new construct
- [ ] An ADR added to `docs/decisions.md` if this was a decision with trade-offs

## If it adds a diagnostic

- [ ] The message says what is wrong, the hint says what to write instead
- [ ] A test proves it fires, and a test proves it does **not** fire on the correct shape
- [ ] Added to `haic explain` if a reader might reasonably disagree with the rule

## If it adds a backend

- [ ] Registered in the registry; no other existing file changed
- [ ] A CI job builds the generated project with the target's real toolchain
