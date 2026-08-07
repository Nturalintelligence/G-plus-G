# Artifact audit

Baseline: `4dd3fde7c1dad428491c3f06eb5c816f5827998e`.

| Candidate | Reachability / concern | Decision | Evidence / test |
|---|---|---|---|
| `Snake_Games/` | Standalone one-off output; not product-reachable. | Remove | Zero-hit source scan. |
| `scripts/run-live-snake-test.ts` | Wrote to a personal Desktop path and called a stale Snake verifier. | Remove | Source inventory and zero-hit scan. |
| Keyword/legacy branch in `orchestrator.ts` | Production-reachable automatic execution based on prose. | Remove | Recognition/security tests. |
| TwoTier/terminal bridge | Renderer-to-host command-string path bypassed approval/FSM. | Remove | IPC/source guard and typecheck. |
| `repair_pack/` | One-off prompt plus assets duplicated from production branding. | Remove | Reference and SHA-256 inventory. |
| `apps/desktop/design-prototypes/` | Ten tracked zero-byte, unreferenced placeholders. | Remove | Repository/reference inventory. |
| `src/release/release-tools.ts` | Required by app, CLI and tests but hidden by broad ignore rule. | Retain and track | Clean-clone build/typecheck. |
| `multi_llm_orchestrator_plan.txt` | Historical product specification referenced by project docs. | Retain | Documentation references; no production import. |
| `scripts/endurance-dialogue.ts` | Product-relevant endurance harness, reachable through npm script. | Retain | `verify:dialogue` package script. |
| Gemini provider/adapters | Legitimate product integration. | Retain | Production registry and adapter tests. |
