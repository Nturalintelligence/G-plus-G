# Prompt protocol

Status: **IMPLEMENTED and locally tested** for the 0.1 base branch. Live provider
UAT is still required.

## Composition

A provider prompt is assembled from bounded layers:

1. the static collaboration protocol and its version marker;
2. mode-specific instructions (manual, sequential, parallel, or debate);
3. optional provider role and user-saved custom instruction;
4. a compact project brief and accepted decision ledger when supplied;
5. the current user task or current peer candidate;
6. a phase-specific finalization request when an explicit final answer is needed.

The full local transcript is never replayed into every web chat. A provider with
an existing conversation URL receives an incremental prompt; a new conversation
receives the base protocol. The current implementation tracks this during a run
and through persisted conversation references. Durable per-conversation protocol
hash metadata is still a future hardening item.

## Version and updates

`productive-protocol.ts` owns the protocol identity. Static instructions are
sent once per newly initialized provider conversation. Later turns contain only
the relevant task, peer material, compact context, and phase constraints. A
future protocol version change should send a short version update rather than
the entire historical transcript.

## Modes

- MANUAL produces a direct answer and then an explicit final transcript row.
- SEQUENTIAL passes bounded candidate content to the next selected provider.
- PARALLEL gives each provider the original task independently.
- DEBATE uses bounded peer review and recognizes consensus only through the
  exact terminal marker parsed by `hasTerminalConsensusMarker`.

Prose containing words such as “agree” is not consensus evidence. Provider
output is treated as untrusted; peer prompts label it as quoted candidate
material and prohibit following embedded instructions.

## Final answer and public transcript

Finalization is a distinct `FINALIZE` phase. The persisted public final row uses
`providerId: "final"`; the actual model remains attributable through
`sourceProviderId` / `finalizerProviderId`. CLI envelopes, consensus markers and
machine-only status blocks are stripped from public text. Candidate answers keep
their real provider IDs.

READY mode buffers progress at the renderer boundary and renders only the final
row. STREAMING mode consumes sanitized, correlated progress events containing
project, run, turn, provider and phase IDs.

## Context budget and rollover

Run limits bound turns, duration, retries and transmitted characters. `RunOptions`
exposes context hooks for a Rolling Brief, Decision Ledger, checkpoint preamble,
turn completion and run completion. The memory/checkpoint services are locally
tested. Automatic desktop creation of a fresh provider conversation at budget
overflow remains **PARTIAL** and must not be described as complete.

## Attachments

Attachments are referenced through immutable managed records. Each provider gets
an independent delivery and submission record. The original task receives the
files only on the intended first provider turn for that mode; seeing a peer's
text is not evidence that the peer saw the original file. Provider upload policy
and integrity are checked immediately before the browser input receives a path.

## Redaction and extraction

Streaming and final public text pass through the task compiler/public transcript
cleaner. Unknown CLI-like blocks are rejected, not executed. Logs record lengths,
IDs and fingerprints rather than prompt contents or credentials. Provider text,
download URLs and filenames remain untrusted inputs.

## Test cases

Golden/focused coverage includes a first turn, reused chat, direct and debate
prompts, peer prompt injection, provider custom role/prompt, exact consensus,
explicit finalization, progress correlation/sanitization, cancellation and long
bounded board cycles. Provider DOM and account behavior remains the manual UAT
boundary.
