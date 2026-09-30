<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project notes

- Phase 1 is a **UI-only prototype**: do not add real Supabase connections, deletion, storage, workers, schedulers or notifications unless explicitly asked.
- All UI data flows through `InfrastructureDataSource` (`src/lib/data/source.ts`); never import mock seed data from components.
- `PHASE_2_ARCHITECTURE_DECISION_RECORD.md` is the authoritative architecture record for the backend; follow its decisions (§21) and do not start destructive work before its Phase 3 prerequisites.
- `prototype/` is PROTOTYPE / SYNTHETIC DATA ONLY: it must only ever target the local disposable database (its `db.ts` safety rail refuses other hosts). Never add real credentials or production hosts there.
- Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` before committing.
- Phase 3B: `worker/` is the production code path (extracted from `prototype/`). Deletion stays disabled: never change the `ALLOW_DELETION=false` default, the kill-switch default, or the `production` refusal in `DELETION_ALLOWED_ENVIRONMENTS`. The web tier (`src/server/live`, `/api/infra`) is read-only. See `PHASE_3B_IMPLEMENTATION_RECORD.md` §16 before any deletion work.
- Integration tests (`npm run test:integration`) need the local DB from `prototype/scripts/start-db.sh` and use synthetic data only.
- Phase 3C: never choose business values (time zones, grace, thresholds, approval policy, provider); missing values must refuse with the `worker/readiness/blockers.ts` messages. Roles come from `control.operator_roles`, never token claims. No dashboard path may execute deletion; the worker stays the final authority. `production_is_read_only` and the notification/scheduling CHECKs may only be lifted by a reviewed migration after `PRODUCTION_DECISION_CHECKLIST.md` and hosted validation are complete.
