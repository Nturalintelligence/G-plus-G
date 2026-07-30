# Adapter development

Implement `ModelAdapter` from `src/adapters/adapter-contract.ts`. A provider must
use its own persistent profile and `ProfileLock`, fail closed when DOM elements
are ambiguous, stop for CAPTCHA/challenges, and bind a response to a pre-send
snapshot rather than selecting the last block.

Before release, run the shared contract scenarios:

1. authenticated and logged-out sessions;
2. short, long, streaming, empty, cancelled, and timed-out responses;
3. challenge and rate-limit pages;
4. closed-tab recovery;
5. ambiguous composer/response DOM;
6. retry without attaching an old response.

Never log cookies, tokens, passwords, or raw browser-profile contents.
