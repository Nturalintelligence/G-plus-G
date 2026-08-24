# Prompt protocol

Status: **IMPLEMENTED and locally tested** for the 0.1 base branch. Live provider
UAT is still required.

## Composition and visible-message invariant

Every invoked provider receives exactly one visible user message per orchestration
turn. `ProviderTurnEnvelopeV1` atomically contains the current task, bounded
project context, optional latest peer contribution/candidates, attachment
references, continuation instruction and output contract. The first message in a
provider conversation prefixes that same envelope with the collaboration
protocol; there is no separate bootstrap, continuation or status message.

The full local transcript is never replayed. Peer content is bounded and marked
as untrusted data. Attachments are browser uploads associated with the same turn,
not extra text messages.

## Version and updates

`prompt-builder.ts` owns the protocol version, SHA-256 identity and text.
`provider_protocol_states` persists initialization independently by provider and
conversation, including an optional project checkpoint revision. The row is
written only after a confirmed provider response, so a failed/unknown submission
cannot silently suppress required initialization. Same-version turns omit the
protocol. A changed version/hash emits a bounded line delta with the same turn
envelope instead of replaying the old protocol.

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

Golden/focused coverage includes atomic first-turn bootstrap, restart/reuse,
provider isolation, bounded protocol delta, direct/debate/final envelopes, peer
prompt injection, custom role/prompt, exact consensus, continuation in-envelope,
progress correlation/sanitization, cancellation and long bounded board cycles.
Provider DOM and account behavior remains the manual UAT boundary.
