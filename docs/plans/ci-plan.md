# CI Plan

The repository currently has no CI workflow. The service and action run TypeScript through `tsx`, so pull requests need an enforced gate that performs typechecking, type-aware linting, and every existing selftest before merge.

Scope: one GitHub Actions workflow, one validation job, no deploy stages, build matrix, or Docker image build. The workflow covers the five packages in the pnpm workspace. `apps/web` is intentionally excluded because it is a standalone demo application with its own dependency graph and no lockfile; give it a separate build workflow if it becomes a shipped or supported application.

## Workflow: `.github/workflows/ci.yaml`

Use a stable workflow and job name so branch protection can require an unambiguous check:

```yaml
name: Repository CI

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  validate:
    name: CI
    runs-on: ubuntu-latest
    timeout-minutes: 15
```

Only `pull_request` is needed. Branch protection on `main` will require pull requests and block direct pushes. If GitHub merge queues are enabled later, add the `merge_group` trigger so the queued merge commit receives the same check.

## Job

Keep the checks in one job: the repository is small, and separate jobs would repeat dependency installation and Postgres setup.

### 1. Setup

1. Check out the repository with `actions/checkout@v4`.
2. Install pnpm with `pnpm/action-setup@v4` and `run_install: false`. With no explicit action version input, it uses the repository's `packageManager` field (`pnpm@11.9.0`). This happens before `setup-node` so pnpm is available when the Node action configures its cache.
3. Install Node 22 with `actions/setup-node@v4`, `cache: pnpm`, and `cache-dependency-path: pnpm-lock.yaml`.
4. Run `pnpm install --frozen-lockfile`. A package-manifest change without its lockfile must fail CI.

### 2. Typecheck

Run the existing root command:

```bash
pnpm typecheck
```

It delegates to the existing `typecheck` scripts in all five workspace packages. Update `packages/cli/tsconfig.json` to include `scripts` and set `rootDir` to `.` so its validation selftest is typechecked as well as executed.

### 3. Type-aware lint

Add root development dependencies on `eslint` and `typescript-eslint`, plus a root flat config. Keep the rules focused on asynchronous correctness rather than formatting:

- Configure the TypeScript parser with `parserOptions.projectService: true` and the repository root as `tsconfigRootDir`.
- Lint `packages/**/*.{ts,tsx,mts}`; ignore generated dependency/build directories.
- Enable `@typescript-eslint/no-floating-promises` as an error.
- Enable `@typescript-eslint/no-misused-promises` as an error. Its conditional checks catch code such as `if (!promiseReturningCall())`.
- Add a root script such as `"lint": "eslint \"packages/**/*.{ts,tsx,mts}\" --max-warnings=0"`.

Run:

```bash
pnpm lint
```

The lint command must use type information; a syntax-only ESLint configuration would not enforce either promise rule correctly.

### 4. Standardize package selftest commands

Every package that contains tests must expose them through a package-level `selftest` script. Root scripts should only orchestrate those package commands; they should not reach into a package to execute a test file directly. This keeps each package independently testable and gives CI one stable repository-wide entry point.

For the CLI, add `"selftest": "tsx scripts/validate-selftest.mts"` to `packages/cli/package.json`. Keep the existing `selftest` scripts in core, service, and action.

The resulting command structure is:

```text
package selftest          -> tests one package
feature-rec:selftest      -> orchestrates core, service, and action
root selftest             -> orchestrates feature-rec:selftest and CLI selftest
```

### 5. Selftests

The current `feature-rec:selftest` command covers core, service, and action. The repository also has a passing CLI validation suite that must not remain a manual-only smoke check.

Add:

- A root `selftest` command that runs `feature-rec:selftest` and the CLI selftest.

CI then runs:

```bash
pnpm selftest
```

The service selftest needs an administrative Postgres connection. Provide Postgres as a job service:

```yaml
services:
  postgres:
    image: postgres:18
    env:
      POSTGRES_PASSWORD: postgres
    ports: ["5432:5432"]
    options: >-
      --health-cmd "pg_isready -U postgres"
      --health-interval 5s --health-timeout 5s --health-retries 10
env:
  TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
```

The service selftest creates a uniquely named database, closes its connections, and drops the database in cleanup, so parallel or retried workflow runs do not collide.

## Local parity

Update the Makefile so:

- `selftest` runs the new root `pnpm selftest` aggregate.
- `ci` depends on `typecheck`, `lint`, and `selftest`.

After that change, `make ci` reproduces the GitHub Actions checks locally, using the existing Docker-managed Postgres instance.

## Branch protection

The GitHub Actions job and the Feature-Rec application Check Run are separate gates. Configure branch protection or a repository ruleset for `main` to:

1. Require changes to arrive through a pull request, which blocks direct pushes.
2. Require the GitHub Actions check named `CI`.
3. Apply the rule to any users or roles that should not be allowed to bypass these gates.

Update the README and `docs/feature-rec.md` during implementation so they instruct maintainers to require both checks, rather than presenting either check as a replacement for the other.

## Deliberately out of scope

- **Docker image build and smoke test** — add these after the Dockerfile lands. The initial CI gate does not depend on an application image because Postgres is supplied as a workflow service.
- **Standalone web demo** — add a dedicated lockfile and build workflow if `apps/web` becomes a supported deliverable.
- **Bundled action packaging check** — add this if the composite action is converted to a committed JavaScript distribution.
- **Migration-drift check** — add an assertion that migration files match the static import map when the migration count grows.
- **Coverage, release automation, and deployment** — add them when the repository has corresponding thresholds or deployable artifacts.

## Definition of done

- A pull request runs the stable `CI` check.
- Installation fails on manifest/lockfile drift.
- All workspace source and test code typechecks.
- Both type-aware promise rules run and fail CI on violations.
- Core, service, action, and CLI selftests pass.
- `make ci` runs the same application checks locally.
- Branch protection is verified with a test pull request: neither a failing `CI` check nor a failing `Feature-Rec` check can merge, and direct pushes to `main` are blocked.
