# Development agent instructions

These instructions apply to coding agents developing and maintaining this
repository. Keep this file focused on development practices; link to project
documentation instead of duplicating it.

## Before editing

- Read [README.md](README.md) for project structure, setup, and commands, and
  [docs/setup-and-operations.md](docs/setup-and-operations.md) for product behavior and operations.
- Inspect the relevant implementation and selftests before changing behavior.
  Plans under `docs/plans/` include historical and superseded designs; check their
  status against current code rather than assuming every proposed step has shipped.
- Check `git status`. Preserve existing staged, unstaged, and untracked work.
  Keep changes scoped to the task; avoid unrelated refactors or formatting churn.

## Coding standards

- Match surrounding TypeScript conventions: strict types, ESM, `node:` built-ins,
  double quotes, semicolons, and existing import style.
- Prefer flat data and direct functions. Introduce an abstraction only when it
  enforces an invariant, owns behavior, improves reuse at multiple call sites, or
  defines a meaningful boundary. Avoid inline wrappers that only add indirection.
- Validate external data with the existing Zod schemas and infer types from them.
  Update shared contracts, producers, consumers, and regression coverage together.
- Use existing provider and storage injection seams. Avoid bypassing them with
  direct network or database calls in orchestration code or tests.
- Await asynchronous work. Deliberate background work needs explicit rejection
  handling. Fix promise misuse instead of suppressing lint rules.
- Explain invariants, concurrency, and compatibility decisions in comments;
  avoid comments that merely restate the code.
- Use the configured package tooling and update dependencies through pnpm with
  the lockfile. Use `pnpm run <script>` explicitly to avoid built-in command
  collisions, particularly `publish`.

## Editing and verification

- When changing code-generation tooling, edit the generator source rather than
  hand-editing generated files. Preserve tracked fixtures and fallback assets.
  Review output changes from local test runs and avoid concurrent tests that
  write to the same paths.
- Before migration or compatibility changes, consult the relevant rollout plan
  and [operational runbook](docs/setup-and-operations.md). Do not remove transitional code
  merely because it appears redundant.
- Extend the relevant existing selftest for meaningful behavior changes. Test
  observable outcomes and failure cases using the existing assertion style and
  provider fakes; avoid tests that only mirror implementation details.
- Run the applicable checks documented in the README through existing package
  scripts. Include cross-package checks when changing shared contracts, image
  checks when changing packaging, and inspect rendered samples when changing
  renderer code.
  Documentation-only edits need link and diff checks, not an application test run.
- Update the owning documentation when behavior or setup changes; keep facts in
  one place. Keep secrets and accidental generated artifacts out of the diff.
- When reviewing a written plan, append every issue found to the bottom of that
  plan file before reporting results. Preserve existing content and distinguish
  resolved issues from open ones.
- Review the final diff. Report what changed, checks actually run, and remaining
  limitations. Never present an unrun or blocked check as passed.
