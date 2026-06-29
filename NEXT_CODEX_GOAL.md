# Next Codex Goal Prompt

```text
/goal Objective: Close the next Telegram Parilka MCP architecture risks until every item in the source TODO is implemented, verified, split, or explicitly blocked with concrete evidence.

Workspace: /root/telegram-parilka-mcp

Source of truth:
- /root/telegram-parilka-mcp/NEXT_ARCHITECTURE_TODO.md

Focus:
- Work P1 first: fail-closed boolean config, safe-by-default live sends, existing-DB send migrations, send/outbox restart reconciliation, real GramJS flood/slowmode handling, large recent catch-up progress, strict runtime tool validation, provider-safe vector namespaces, vector range correctness, and deployed-entrypoint CI.
- Then work P2 correctness/durability/operator trust, then P3 test and hygiene follow-ups.
- Keep embeddings disabled unless the TODO item being worked explicitly requires embedding tests with fake/local providers.
- Do not perform live Telegram sends unless the user explicitly approves a concrete outgoing message in the current turn.

Execution loop:
1. Read /root/telegram-parilka-mcp/NEXT_ARCHITECTURE_TODO.md before starting and after every compaction/resume.
2. Convert open TODOs into an internal update_plan; keep exactly one item in progress.
3. Pick the highest-impact unblocked P1 item first, inspect the relevant files named in the TODO, implement with small scoped edits, and avoid unrelated refactors.
4. After each task, update NEXT_ARCHITECTURE_TODO.md: check off completed work, add status/verification notes, split oversized tasks, or mark blockers with exact evidence.
5. Run focused verification for touched behavior, then baseline checks before marking the task done.
6. Commit and push intentional completed changes to origin main with clear commit messages.
7. Continue autonomously until completion criteria are met or the same blocker repeats for three goal turns.

Verification:
- Always run npm run check before marking code work done.
- Run npm test for behavior changes, or targeted node --test commands plus npm test before larger milestones.
- Run npm run smoke:mcp after MCP tool contract, entrypoint, config, or wrapper changes.
- Run npm run secret-scan after docs/config/scripts changes.
- Run npm run validate-config after config/env parsing changes.
- For deployment/runtime changes, run npm run build and smoke the wrapper path when practical.
- For send-safety work, verify without live Telegram posting.

Completion criteria:
- Every item in /root/telegram-parilka-mcp/NEXT_ARCHITECTURE_TODO.md is checked off, implemented and verified, explicitly split into tracked follow-up work, or marked blocked with exact evidence.
- All P1 items are closed before treating the system as safe for more autonomy.
- Baseline verification passes, or failures are documented with exact command output and cause.
- Working tree is clean except intentional uncommitted work the user asked to leave.
- Final response summarizes completed tasks, commits pushed, verification run, updated source files, and remaining blockers.

Blocked criteria:
- Mark blocked only after the same blocker repeats for three goal turns and no meaningful progress is possible without user input or an external state change.
```
