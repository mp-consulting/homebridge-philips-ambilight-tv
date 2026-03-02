# CLAUDE.md

## Project overview

Homebridge plugin that exposes Philips Ambilight TVs as HomeKit Television accessories. Communicates with TVs via the JointSpace v6 REST API and a long-poll WebSocket (NotifyChangeClient) for near-instant state updates.

## Commands

| Task | Command |
|------|---------|
| Build | `npm run build` |
| Lint | `npm run lint` |
| Test | `npm test` |
| Test (watch) | `npm run test:watch` |
| Test (coverage) | `npm run test:coverage` |
| Dev (auto-reload) | `npm run watch` |
| Run locally | `npm start` |

Lint enforces zero warnings. Build compiles to `dist/` via `tsc`. Prepublish runs test + lint + build.

## Architecture

```
src/
├── index.ts              # Plugin registration
├── settings.ts           # PLATFORM_NAME, PLUGIN_NAME constants
├── platform.ts           # Homebridge DynamicPlatformPlugin
├── platformAccessory.ts  # TV accessory setup & HAP handlers
├── api/                  # JointSpace v6 client, digest auth, fetch helpers
└── services/             # Ambilight, polling, long-poll, input sources, sensors

test/                     # Unit tests (mirrors src/ structure)
homebridge-ui/            # Custom UI for pairing wizard & source config
```

## Code conventions

- **ESM only** — `"type": "module"`, imports use `.js` extensions
- **TypeScript strict mode** — ES2022 target, `nodenext` module resolution
- **Type-only imports** — `import type { Foo }` enforced by ESLint
- **Style** — single quotes, 2-space indent, semicolons, trailing commas in multiline, max 160 chars/line
- **Naming** — PascalCase classes/types, camelCase functions, UPPER_SNAKE_CASE constants, `_prefix` for unused args
- **Section markers** — `// ====...` comment blocks separate constants / types / class sections
- **No `any`** — `@typescript-eslint/no-explicit-any` is a warning; avoid it

## Testing

- **Vitest v4** with globals (`describe`, `it`, `expect`, `vi`)
- Tests in `test/` directory, mirroring `src/` structure
- Mocking: `vi.mock()` for modules, `vi.fn()` for stubs
- Fake timers: `vi.useFakeTimers()` in beforeEach, `vi.useRealTimers()` in afterEach
- Use `vi.advanceTimersByTimeAsync()` for async timer tests

## Git conventions

- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `perf:`, `style:`
- Do not include co-authored-by lines (setting: `includeCoAuthoredBy: false`)
- CI runs on Node 20.x and 22.x
- npm publish triggered by GitHub releases (trusted publishing with OIDC provenance)
