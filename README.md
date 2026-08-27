# build-dashboard

> A GitHub Action that publishes an HTML dashboard of your GitHub Actions builds:
> **build durations over time**, **step durations per workflow**, a **timeline of
> every run** (jobs → steps), and — for Maven steps profiled with
> [mvn-lens](https://github.com/mvn-perf/mvn-lens) — the **Maven build-time trend**
> and a link to **every mvn-lens report**, straight from the step that produced it.

Zero dependencies (plain Node ≥ 20, runs on the runner's Node 24), one
self-contained `index.html`, history that outlives GitHub's 90-day log/artifact
retention.

## What you get

| Page | Shows |
|---|---|
| **Overview** (`#/`) | One card per workflow: run duration over time (points coloured by conclusion), success rate, median / p90, slowest run. Filters: date range, branch, event, status. |
| **Workflow** (`#/workflow/<id>`) | The duration trend, then **one stacked-bar chart per job** — one bar per run, one segment per step — so you see which step grew. Runs table underneath. |
| **Run** (`#/run/<id>`) | A Gantt **timeline** of the jobs and their steps, relative to the run start. A step profiled with mvn-lens carries an **`mvn-lens ↗` chip that opens its report**, and the Maven session itself is drawn as an orange bar under the step. |
| **Maven builds** (`#/maven`) | Every *workflow · job › step (· label)* that attached an mvn-lens report, each with its Maven total-time sparkline. |
| **Maven build** (`#/maven/<key>`) | The trend of Maven **total time / wall-clock / CPU / GC / JIT C2 / dependency downloads / test time** across runs, the slowest modules of the latest build, and a table listing **all reports** of that build with a link to each. |

Everything is clickable: a point → the run, a bar → the run, a chip → the report.

## Quick start

### 1. Attach mvn-lens reports (in your build workflow)

Enable mvn-lens in the project (`.mvn/extensions.xml`, see the
[mvn-lens README](https://github.com/mvn-perf/mvn-lens#quick-start)), then add one
step right after each Maven step:

```yaml
permissions:
  contents: read
  actions: read        # lets the step identify its own job through the API

steps:
  - name: Build with Maven
    run: mvn -B -ntp verify

  - name: Attach mvn-lens report
    if: always()                                  # a failed build's report is the one you want
    uses: mvn-perf/build-dashboard/mvn-lens@v1
    with:
      report: target/mvnlens/report.html          # default; globs and lists are accepted
      # job-name: JDK ${{ matrix.java }}          # when the job has a custom name:
```

The step finds which job and step it runs in (by `job-name`, runner name or job
key, and the step that was running when the report was written), reads the Maven
session summary out of the report, and uploads `report.html` + `meta.json` as an
artifact named `mvn-lens--j<jobId>--s<step>`. Nothing else changes in your
workflow. Full example: [`examples/ci-with-mvn-lens.yml`](examples/ci-with-mvn-lens.yml).

### 2. Publish the dashboard (its own workflow)

```yaml
name: Build dashboard
on:
  workflow_run:
    workflows: ['CI']          # refresh as soon as a CI run completes
    types: [completed]
  schedule:
    - cron: '17 3 * * *'       # daily catch-up
  workflow_dispatch:

permissions:
  actions: read                # runs, jobs, artifacts
  contents: write              # push to gh-pages

concurrency:
  group: build-dashboard
  cancel-in-progress: false

jobs:
  dashboard:
    runs-on: ubuntu-latest
    steps:
      - uses: mvn-perf/build-dashboard@v1
```

Then, once: **Settings → Pages → Source: Deploy from a branch → `gh-pages` / (root)**.
The first run creates the branch; the site lives at
`https://<owner>.github.io/<repo>/`. Full example: [`examples/build-dashboard.yml`](examples/build-dashboard.yml);
a variant deploying through `actions/deploy-pages` is in
[`examples/build-dashboard-pages-artifact.yml`](examples/build-dashboard-pages-artifact.yml).

## How it works

```
your CI workflow                                   Build dashboard workflow
────────────────                                   ────────────────────────
mvn verify ──► target/mvnlens/report.html          1. clone gh-pages (previous site = the history)
      │                                            2. GET /actions/workflows, /workflows/{id}/runs
      ▼                                            3. for new / changed runs:
mvn-perf/build-dashboard/mvn-lens                        GET /runs/{id}/jobs      → jobs, steps, timings
  · which job/step am I?  (GET /runs/{id}/attempts/{n}/jobs, match runner)
  · Maven summary from the report's embedded model       GET /runs/{id}/artifacts → mvn-lens--* → download
  · upload artifact  mvn-lens--j<job>--s<step>               unzip report.html + meta.json → reports/<run>/…
                                                   4. merge into data/history.json, prune
                                                   5. render index.html (Chart.js + data inlined)
                                                   6. commit → push gh-pages (single orphan commit)
```

- **History beyond retention.** GitHub keeps job/step timings and artifacts for
  90 days by default. The dashboard stores what it saw in `data/history.json` on
  the published branch and only fetches runs it has not seen (or that were still
  running), so the trends keep growing and each refresh costs a handful of API
  calls.
- **Reports are copied, not linked.** mvn-lens report artifacts expire; the
  dashboard copies each `report.html` into `reports/<run>/<artifact>/` on the
  site. `keep-reports` bounds how many runs per workflow keep their HTML (each
  report is 1–2 MB); older runs keep the Maven timings for the trend charts.
- **Small repository.** By default the branch is rewritten as a single orphan
  commit on every publish (`force-orphan: true`), so deleted reports do not pile
  up in git history. The push is `--force-with-lease` on the tip that was checked
  out: if another publish landed meanwhile, the action re-reads that history,
  merges the runs it collected into it and retries — nothing is lost. Keep the
  `concurrency` group anyway; it avoids the retry. The default branch is never
  force-pushed.
- **Attribution that survives matrices and re-runs.** The `meta.json` written
  inside the build job pins the report to a job **id**, step **number** and run
  **attempt**; the dashboard falls back to runner name, job name, job key, and
  finally the artifact name. Artifacts of an earlier attempt are ignored once a run
  is re-run. Reports it cannot place are still listed on the run page.
- **Trust model.** Report artifacts are user-controlled content that ends up as
  HTML on your Pages origin. Only files that actually contain an mvn-lens model
  are published, and **runs from forked repositories are skipped** (a `pull_request`
  workflow lets anyone upload artifacts) unless you set `include-fork-runs: true`.
  The publishing token is passed to git through the environment, never on a
  command line, and is redacted from error output; the report paths recorded in
  `history.json` are validated before anything touches the file system.

## Inputs — `mvn-perf/build-dashboard`

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | Needs `actions: read`; plus `contents: write` when publishing to a branch. `pages: read` is optional (exact site URL for custom domains). |
| `repository` | current | `owner/name` to chart. |
| `workflows` | all | Names, file names (`ci.yml`), paths or ids; newline- or comma-separated. |
| `exclude-workflows` | — | Same syntax. |
| `include-self` | `false` | Also chart the workflow the action runs in. |
| `branches` / `events` | all | Restrict collection. The site itself has branch/event filters, so leave these empty unless you want to keep the history small. |
| `max-runs` | `200` | Runs kept per workflow. |
| `lookback-days` | `90` | Only look for **new** runs this recent (the history keeps older ones). |
| `run-id` | triggering run | Run id(s) to (re)process even when unchanged or older than `lookback-days` (workflow and fork filters still apply); defaults to `github.event.workflow_run.id`. |
| `include-fork-runs` | `false` | Also collect runs whose head repository is a fork. See the trust model above. |
| `force-refresh` | `false` | Re-fetch every run in range. |
| `concurrency` | `4` | Parallel API requests. |
| `mvn-lens-artifact-prefix` | `mvn-lens--` | Artifacts with this prefix are mvn-lens reports; empty disables collection. |
| `download-reports` | `true` | Set to `false` to chart only durations. |
| `keep-reports` | `50` | Runs per workflow whose report HTML stays on the site. |
| `publish` / `publish-branch` | `true` / `gh-pages` | Commit & push the site to that branch. `publish: false` → only write `output-dir`. |
| `publish-dir` | branch root | Sub-directory inside the branch (other content of the branch is preserved). |
| `force-orphan` | `true` | Single-commit branch (force-with-lease). `false` appends commits. Refuses the repository's default branch. |
| `commit-message`, `commit-user-name`, `commit-user-email` | bot | Commit identity/message. |
| `output-dir` | `build-dashboard-site` | Where to write the site when not publishing (its previous content is the history to extend). When publishing, setting it also copies the published site there. |
| `history-file` | `<site>/data/history.json` | Explicit history to load. |
| `seed-url` | — | When not publishing and there is no local history: fetch `data/history.json` and the linked reports from this live URL first. |
| `site-url`, `title` | derived | Cosmetics for the summary / page title. |
| `dry-run` | `false` | Build, do not push. |

Outputs: `site-dir`, `site-url`, `runs-processed`, `runs-total`, `reports-collected`, `published`, `commit-sha`.

## Inputs — `mvn-perf/build-dashboard/mvn-lens`

| Input | Default | Description |
|---|---|---|
| `report` | `target/mvnlens/report.html` | Path(s)/glob(s) of report(s); the first is the step's primary report. |
| `step-name` | auto | The step that ran Maven. By default, the step that was running when the report file was written (normally the previous step). |
| `job-name` | auto | The job's display name, for jobs with a custom `name:` (matrix expressions expand fine: `JDK ${{ matrix.java }} · ${{ matrix.os }}`). Without it the job is found by runner name, then job key. |
| `label` | — | Distinguishes several Maven builds of the same step (a matrix leg, a scenario). Part of the series identity. |
| `github-token` | `${{ github.token }}` | Needs `actions: read` to resolve the job/step. Without it the report is attached by job name only. |
| `include-model` | `false` | Also upload `model.json`. |
| `if-no-files-found` | `warn` | `warn`, `error` or `ignore`. |
| `retention-days` | repo default | Artifact retention — the dashboard copies the report, so a few days are enough once it runs regularly. |
| `artifact-prefix` | `mvn-lens--` | Must match the dashboard's `mvn-lens-artifact-prefix`. |

Outputs: `artifact-name`, `found`, `maven-total-ms`, `job-id`, `step-name`.

No `mvn-lens` step? Any artifact whose name starts with `mvn-lens--` and contains
an HTML report is picked up too; name it `mvn-lens--j<jobId>--s<stepNumber>` to
attribute it, otherwise it appears as a run-level report.

## Site layout

```
index.html            the dashboard (self-contained; the dataset is inlined, gzip-compressed above 256 KB)
data/history.json     the dataset — schemaVersion 1, runs newest first (see src/history.js for the shape)
reports/<runId>/<artifact>/report.html
.nojekyll
```

`history.json` is plain JSON meant for other tooling too: every run with its
jobs, steps (`number`, `name`, `conclusion`, `startedAt`, `completedAt`,
`durationMs`) and `mvnLens` entries (`jobId`, `stepNumber`, `reports[].summary`
with `totalMs`, `wallMs`, `cpuMs`, `gcMs`, `c2Ms`, `downloadMs`, modules, …).

## Development

```bash
npm test                  # node:test suite (API client, zip, mvn-lens parsing, collector, site, git publishing, attach step)
npm run lint              # syntax check of everything that runs un-bundled on the runner
node scripts/demo.js      # a synthetic dashboard in .tmp/demo-site (real reports if ../mvn-lens has built ITs)

# a real dry run against any repository you can read
GITHUB_TOKEN=$(gh auth token) INPUT_REPOSITORY=mvn-perf/mvn-lens INPUT_PUBLISH=false \
INPUT_OUTPUT_DIR=.tmp/site INPUT_MAX_RUNS=30 node src/main.js
```

The action runs straight from `src/` on the runner's Node (`using: node24`; the
code needs nothing newer than Node 20) — there is no build step, no
`node_modules`, nothing to bundle. Chart.js 4.4.6 (MIT) is vendored in
`site/vendor/` (see `site/vendor/THIRD_PARTY.md`).

## Versions

The examples reference `@v1`; until that tag exists on `mvn-perf/build-dashboard`,
pin a commit or use `@main`. Releases follow semver with a moving `v1` tag.

## Requirements & limits

- GitHub.com or GHES with the REST API (`GITHUB_API_URL` is honoured).
- The `GITHUB_TOKEN` API budget is 1 000 requests/hour per repository: the first
  backfill of `max-runs` runs per workflow costs ~2 requests per run (jobs +
  artifacts), later refreshes a few dozen.
- Step timings come from the Jobs API (second granularity); runs older than the
  log retention keep whatever the history recorded.
- Reports on the site are public if the Pages site is public.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
