# Production Deletion Checklist

> **PRODUCTION DELETION: DISABLED.**
>
> This checklist is the gate before any future production deletion. It is **not** satisfied today.
> Every line needs a named person, a date and evidence. A line marked N/A must say why.
> Deletion additionally requires the worker's own checks. Nothing on this page replaces them.

Job ID: ____________ · Application: ____________ · Table(s): ____________ · Environment: production

## A. Programme-level prerequisites (once)

| ☐ | Requirement | Evidence | Signed (name, date) |
|---|---|---|---|
| ☐ | All decisions in `PRODUCTION_DECISION_CHECKLIST.md` §1–§6 and §8 recorded | checklist with references | |
| ☐ | Hosted Supabase validation passed; all `manual` items observed | `hosted-validation-results/…json` | |
| ☐ | Archive-and-verify production pilot completed ≥ 3 clean cycles | `PRODUCTION_PILOT_PLAN.md` evidence | |
| ☐ | Archive provider implemented, in the approved region, private, with versioning/lock per AR decisions | provider test results | |
| ☐ | Safety copy mechanism in place (AR-5), or its absence formally accepted | decision reference | |
| ☐ | Authentication live; APPROVER and ADMIN held by named people; MFA per S-5 | `operator_roles` export | |
| ☐ | Secret store (S-3) in use; rotation tested | rotation record | |
| ☐ | Reviewed code change allowing `production` in `DELETION_ALLOWED_ENVIRONMENTS` **and** a migration lifting `production_is_read_only` for this application | PR links | |
| ☐ | Archive role granted `DELETE` on the approved table(s) only, by the application owner | owner confirmation | |
| ☐ | Restore rehearsal from a verified archive into a scratch database succeeded | rehearsal note | |

## B. Per-job checks

| ☐ | Check | Operator | Reviewer |
|---|---|---|---|
| ☐ | Preflight §1 of `PRODUCTION_ARCHIVE_RUNBOOK.md` complete | | |
| ☐ | Candidate preview reviewed; boundary and final-day count understood; exclusions explained | | |
| ☐ | Job mode is `ARCHIVE_VERIFY_DELETE` (created deliberately, not from the dashboard) | | |
| ☐ | Verification **PASSED** for the current attempt; all six stages listed | | |
| ☐ | Schema hash unchanged since the freeze | | |
| ☐ | Candidate fingerprint verification ✓ (key set + full restore) and candidate digest recorded | | |
| ☐ | Estimated database impact reviewed (rows, % of table, reusable space; no VACUUM FULL) | | |
| ☐ | Approvals: quorum met by distinct APPROVERs; none expired; none rejected; the job creator not approving (if A-6) | | |
| ☐ | Authorization issued by an ADMIN who is not an approver; typed job ID; not expired | | |
| ☐ | Inside the configured deletion window | | |
| ☐ | Worker configuration for this run only: `ALLOW_DELETION=true` on the designated worker; logged | | |
| ☐ | Kill switch released by an ADMIN with a reason; the person who will re-engage it is named | | |
| ☐ | Worker gate output shows **no** blocking reasons before execution | | |

## C. After execution

| ☐ | Check | Operator | Reviewer |
|---|---|---|---|
| ☐ | Job status `completed` or `completed_with_exceptions`; reconciliation `reconciled = true` for every table | | |
| ☐ | Skipped rows (edited / newly referenced) explained | | |
| ☐ | Kill switch re-engaged; `ALLOW_DELETION` returned to `false` | | |
| ☐ | Post-job health collection shows the expected row counts | | |
| ☐ | Audit-log extract attached (approvals, authorization, attempted, batches, verified, completed) | | |

**Final sign-off:** Operator ____________ · Approver ____________ · Admin ____________ · Business owner ____________
