# Branching

Git Flow, with the two long-lived branches protected.

| Branch | Holds | Merges from | Protected |
| --- | --- | --- | --- |
| `main` | What is released. Every commit is a version. | `release/*`, `hotfix/*` | yes |
| `develop` | What is next. Always green. | `feature/*`, `bugfix/*` | yes |
| `feature/<name>` | One change | branched from `develop` | no |
| `bugfix/<name>` | One fix that is not urgent | branched from `develop` | no |
| `release/<version>` | Stabilising a version | branched from `develop` | no |
| `hotfix/<version>` | An urgent fix to a release | branched from `main` | no |

The short-lived branches are created when they are needed, not up front.

## Everyday work

```bash
git switch develop
git pull
git switch -c feature/optimistic-concurrency

# … work, commit …

git push -u origin feature/optimistic-concurrency
gh pr create --base develop --fill
```

CI runs on the pull request. Once it is green, merge.

## Cutting a release

```bash
git switch -c release/0.2.0 develop
# bump the version, update the status section of the README
git push -u origin release/0.2.0
gh pr create --base main --title "release 0.2.0" --fill
```

After it lands on `main`, tag it and merge back so `develop` carries the release
commits:

```bash
git switch main && git pull
git tag -a v0.2.0 -m "0.2.0" && git push origin v0.2.0
git switch develop && git merge --no-ff main && git push
```

## Fixing a release in a hurry

```bash
git switch -c hotfix/0.2.1 main
# … fix, commit …
gh pr create --base main --title "hotfix 0.2.1" --fill
```

Then merge `main` back into `develop`, exactly as after a release. A hotfix that
never reaches `develop` comes back as a regression in the next version.

## What protection enforces

On both `main` and `develop`:

- no direct pushes — every change arrives through a pull request;
- no force pushes and no branch deletion;
- linear history, so the log reads as a sequence rather than a graph;
- CI must pass before merging.

Admins are included, so the rules apply to the maintainer too. To lift that in an
emergency:

```bash
gh api -X PATCH repos/dscanavall11/ai-lang/branches/main/protection/enforce_admins
```

Re-enable it with `-X POST` on the same endpoint.
