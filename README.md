# ceo

## One conversation for all your projects

Coding agents can do substantial work inside a project. Running several projects gives you another job: distributing context, prompting workers, checking results and coordinating handoffs. Objectives stall when nobody follows up or a worker waits unnoticed.

**Tell ceo what you want to achieve. It assembles teams, coordinates your existing agents, follows the results, and comes back with outcomes or decisions.**

ceo is a small TypeScript harness built on Pi, with Orca supplying worker execution and visibility. CompanyOS defines editable teams in Git. It starts with engineering teams for a personal website and an open-source project.

```text
You ⇄ ceo (Pi conversation + durable loop)
       ├── private goals, decisions, memory and operation receipts
       ├── CompanyOS roles and pinned team graphs
       └── Orca Runs, tasks, workers, sessions and messages
```

## Principles

Own objectives over time. Keep one relationship with the user. Use configured harnesses and platform connections. Start with the smallest useful team. Treat teams as editable playbooks. Let the model choose priorities while the runtime records operations, enforces limits and reconciles failures. Every result connects to its goal, worker, revision and evidence.

Autonomy has an explicit scope. Founder authority, spending, credentials, resource ceilings and release requirements are outside editable team definitions.

## Install and run

Requires Node 22.19 or newer, Git, authenticated `gh`, a running Orca host with orchestration support and a configured Pi provider.

```sh
npm ci
npm run build
node dist/cli.js --help
```

Copy `examples/config.yaml` to a private `~/.ceo/config.yaml` and replace its paths, repositories, exact catalog commits and native harness bindings. Do not put that file in a public repository. Run `ceo doctor` after installing the executable through your preferred local package workflow.

Launch `ceo host` in its own Orca terminal. Orca supplies its caller identity. Pi provider login and model selection remain native Pi commands. Ordinary-terminal `ceo attach` connects to that host's private authenticated Unix socket; inputs, answers and session history share one conversation. From an ordinary terminal, `ceo` can create its own Orca terminal once and records the launch receipt before retrying an uncertain result. Remote installations run ceo on the Orca host; use an SSH terminal there to attach.

For Orca's Pi launch profile, use a command override pointing to `ceo host --config /absolute/private/config.yaml`. Preserve Orca's native Pi extension flags and environment. ceo disables discovery of repository-supplied extensions, skills, prompt templates and MCP servers; configured native launch extensions passed explicitly remain supported. CompanyOS is read as data.

## Delivery and decisions

Each goal owns one Orca Run and pins a CompanyOS commit. The runtime imports the team graph and dispatches eligible roles. Workers report actual evidence into private files. Orca remains authoritative for lifecycle, including unresolved/disconnected workers and terminal release accounting.

The engineering flow is plan → plan approval → development → independent review → QA → release readiness → release approval → publication confirmation → production verification. ceo never performs publication in the pilot. Approvals bind a specific plan hash or candidate commit. Respond with:

```text
approve <decision-id>
reject <decision-id> <feedback>
published <decision-id>
```

Only founder input can resolve a decision; the model has no approval tool. Changing an artifact prevents reuse of its approval. Scoped Linear intake can create goals and mirror decisions; the ceo conversation remains sufficient.

## Persistence and recovery

`~/.ceo/` contains Pi JSONL sessions, searchable Markdown memory and a SQLite operational ledger. Orca owns worker histories and lifecycle. ceo stores goals, decisions, exact catalog pins, mappings, events and idempotency receipts. It persists intent before writes, preserves uncertain operations and replays only confirmed native receipts with the original UUID. Markdown is reasoning context, not a transactional queue. External memory can implement the small document read/write/search interface later.

The loop polls messages every five seconds, execution every minute and intake every five minutes. Idle polling makes no model calls. Model turns are serialized through the same Pi session. One coordinator lease prevents duplicate portfolio owners. Defaults are three workers globally, one implementation and one active workflow per project, with daily turn and dispatch ceilings.

## Team evolution

An explicitly authorized installation can change subordinate skills and team graphs in an isolated checkout, publish generic changes to `ceo/active`, and activate the exact commit for future goals. It records the bottleneck, expected result, previous revision and rollback privately. Existing goals stay pinned. One experiment per project per week is permitted. Runtime policy validates scope, public-content boundaries, graph dependencies and unchanged execution authority; role repositories never provide executable extensions.

## Validation and pilot status

```sh
npm run check
npm test
npm run build
```

Fixture and fault tests cover multi-project progress, approvals, revision changes, receipt recovery, native settlement, idle queues, organization activation/rollback and authenticated terminal attachment. Live cutover requires a bounded smoke test with two installed harnesses, native session visibility and reconciliation of existing workers. Preserve the previous pilot's IDs, plans and pending decisions; pause its previous schedule only after a verified handoff. Temporal and unrelated schedules remain paused.

New-project provisioning, cloud deployment teams, sales organizations, external memory services and a dedicated Orca chat window follow the reliable two-project pilot.
