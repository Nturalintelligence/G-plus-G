# First run

1. Install Node.js 20 or newer.
2. Run `npm install` and `npx playwright install chromium`.
3. Start the desktop app with `npm run desktop:start`.
4. Create a project.
5. Use **Login · chatgpt** and **Login · gemini**. Gemini authentication opens the
   installed system Google Chrome because Google blocks sign-in inside browsers
   controlled by automation. Close that dedicated Chrome window after Gemini opens;
   the application then reuses the saved session.
6. Enter a task, select providers and a bounded mode, then run it.
7. Open **Profile · Settings** in the header to choose your local display name,
   preferred mode/providers, orchestration limits, theme, density, and text scale.
8. Build the project specification in the right-hand constructor. Requirements,
   decisions, constraints, questions, and acceptance criteria are saved as a
   versioned draft. Each item can be linked to a specific model response.

No configuration file or API key is required. Browser sessions and the project
database remain local to the current OS account.

On Windows all runtime data is stored under:

```text
%APPDATA%\multi-llm-orchestrator-feasibility
```

The desktop app and CLI share this database, provider profiles, logs, and exports.
Desktop preferences are stored alongside them in `settings.json`. This file never
contains passwords, cookies, API keys, or tokens.
