# Experimental work: unfinished and blocked items

Updated: 2026-08-10  
Branch: `experimental`

## Implemented locally

- Styled safe ReactMarkdown/GFM output for headings, lists, quotes, code and tables.
- Provider-conversation attachment deduplication by confirmed SHA-256 delivery.
- Recognition-only `G_PLUS_G_EXECUTION_V1` boundary with execution explicitly disabled.

## Still requires manual UAT

- Send one file to ChatGPT and Gemini, then attach identical bytes under the same or another name and confirm that neither provider uploads it again in the same conversation.
- Modify the file and confirm that both providers upload the new digest once.
- Render a real model response containing nested lists, a wide table, a quote, inline code and a long code block in dark and light themes.

## Secure Runtime not implemented

Real code execution remains disabled. The source plan does not define the exact schemas for `ApprovalRequirementV1` and `IntegritySpecV1`, and no Windows sandbox backend has been approved.

Required next decisions and work:

1. Define the missing strict schemas and immutable hash relationships.
2. Choose Windows Sandbox/VM/WSL2 or a separate worker-host trust boundary.
3. Implement an execution-specific persistent FSM, approval broker and policy engine.
4. Prove default-off networking, host filesystem/credential isolation, quotas and process-tree termination.
5. Add adversarial, fuzz, crash recovery and sandbox escape tests before enabling any Run action.

## GitHub publication status

The temporary GitHub 403 observed immediately after the visibility change cleared without a workaround. Publication is complete:

- anonymous repository request returns HTTP 200;
- release `v0.0.1` and its Windows installer are public;
- `main`, `uat` and `prod` point to the verified release commit;
- `experimental` contains the changes listed above;
- obsolete remote work branches were deleted.
