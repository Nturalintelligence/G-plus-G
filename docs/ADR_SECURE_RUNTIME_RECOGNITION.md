# ADR: Secure Runtime recognition boundary

Status: **experimental / recognition only**  
Date: 2026-08-10

## Decision

The `experimental` branch may recognize exact `<G_PLUS_G_EXECUTION_V1>` blocks and replace their machine JSON in the public transcript with a non-executable notice.

This stage must not create jobs, approvals, processes, commands or artifacts. Markdown and ordinary code fences remain display-only content.

## Reason

The Secure Runtime plan does not yet define the exact schemas of `ApprovalRequirementV1` and `IntegritySpecV1`, and no acceptable Windows sandbox backend has been selected. Implementing execution before those decisions would falsely present host-process execution as isolation.

## Required before execution exists

- define the missing strict schema types and `additionalProperties: false` rules;
- choose and threat-model a Windows sandbox backend;
- persist an idempotent job FSM independently from CLI tasks;
- implement approval bound to envelope/source/runtime hashes and capabilities;
- prove network-off, host-filesystem isolation, resource limits and process-tree termination;
- add adversarial, recovery and sandbox escape tests.

Until then, every recognized envelope is explicitly labelled **execution disabled**.
