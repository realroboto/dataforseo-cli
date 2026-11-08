# Architecture decisions

- [0001 Compact output by default](/adr/0001-compact-output.md) - Envelope and empty values dropped, one item per line, 9,000-character budget.
- [0002 Exit-code table 0–6](/adr/0002-exit-code-table.md) - One code per outcome, money spent or not.
- [0003 Reuse on by default](/adr/0003-reuse-on-by-default.md) - Same paid request within 12 h returns stored response at $0; deviates from gapi ADR 0001.
- [0004 No paid retry without proof of cost 0](/adr/0004-no-paid-retry-without-cost-0.md) - Paid call retries only on cost 0; lost connection exits 1.
- [0005 Spec source = runtime check + snapshot](/adr/0005-spec-source-runtime-check-and-snapshot.md) - Daily check of vendor master, committed snapshot fallback.
- [0006 Sandbox contract test on the Mac only](/adr/0006-sandbox-contract-test-mac-only.md) - Real sandbox HTTP before release; login never on GitHub.
- [0007 Staged publish](/adr/0007-staged-publish.md) - OIDC `npm stage publish`; owner approves each version.
- [0008 Vendor overlay + strict validation](/adr/0008-vendor-overlay-strict-validation.md) - Overlay 1.0 fixes vendor faults; `--no-validate` opt-in.

Citations `NN:L`, `rNN:L` point into owner planning map: key in [spec overview](/spec/overview.md) (Citation key).
