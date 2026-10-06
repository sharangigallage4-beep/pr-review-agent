# Team coding conventions (Node.js 18+ / ESM / TypeScript strict)

When a changed line breaks a rule below, report it and name the rule number (e.g. "Rule N3").
Naming and convention findings are severity "low" unless the rule says otherwise.

## Naming
- N1. Variables, functions, parameters: camelCase (`githubToken`, `loadConfig`). Never snake_case or PascalCase.
- N2. Interfaces, types, classes: PascalCase (`AppConfig`).
- N3. Module-level constants that never change: UPPER_SNAKE_CASE (`REQUIRED_ENV_VARS`).
- N4. Environment variable names: UPPER_SNAKE_CASE (`GITHUB_TOKEN`).
- N5. Booleans start with is/has/should/can (`isReady`, not `ready`).
- N6. File names: camelCase (`loadEnv.ts`). No spaces or uppercase-only names.
- N7. No single-letter names except loop counters `i`, `j` and short callbacks (`e` for an event/error is fine).

## Syntax and language
- S1. Use `const` by default, `let` only when reassigned. Never `var`. (severity: medium)
- S2. Always use strict equality `===` / `!==`, never `==` / `!=`. (medium)
- S3. Statements end with a semicolon, strings use single quotes, indent 2 spaces.
- S4. Use ESM `import` / `export` only. No `require()` or `module.exports`.
- S5. Relative imports include the `.js` extension (`import { x } from './config.js'`).
- S6. Prefer named exports. Avoid default exports.
- S7. Every opening bracket, brace, parenthesis and quote must be closed. A missing or extra one
  is a syntax error and is always severity "critical".
- S8. No unused variables or imports, no leftover `console.log` debugging.

## Errors and async
- E1. Throw `Error` objects with an actionable message that says what is wrong and what to do. Never throw plain strings. (medium)
- E2. Use `async` / `await`. Every call that returns a Promise must be awaited or returned. (high)
- E3. Never leave a `catch` block empty. Handle, log, or rethrow. (medium)
- E4. Validate inputs at the boundary (function arguments from outside, parsed JSON, `process.env`).

## Configuration and secrets
- C1. Read `process.env` only in config loaders, never deep inside business logic.
- C2. Required environment variables must be checked at startup and fail fast, listing every missing one. (medium)
- C3. Never hardcode secrets, tokens, passwords or API keys in source. (critical)
- C4. Never log a secret or token.

## Security
- X1. Never use `eval`, `new Function`, or `child_process.exec` with unsanitized input. (critical)
- X2. Database queries must be parameterized, never built by string concatenation. (critical)

## Documentation
- D1. Exported functions and interfaces have a short JSDoc comment explaining purpose, not restating the name.
