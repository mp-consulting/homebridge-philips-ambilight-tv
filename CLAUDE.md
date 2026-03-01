# CLAUDE.md

## Project Overview

Homebridge plugin (`@mp-consulting/homebridge-philips-ambilight-tv`) for Philips Android TVs with Ambilight. Provides power control (WOL), input selection, volume, remote functions, and Ambilight color control with Adaptive Lighting support.

## Tech Stack

- **Language**: TypeScript (strict, ES2022, ESM via NodeNext)
- **Runtime**: Node.js ^20.18.0 || ^22.10.0, Homebridge ^1.8.0 || ^2.0.0-beta
- **Testing**: Vitest with coverage
- **Linting**: ESLint 9 flat config with typescript-eslint
- **Key deps**: `undici` (HTTP), `bonjour-service` (mDNS), `node-arp` (ARP discovery)

## Commands

- `npm run build` — Compile TypeScript to `dist/`
- `npm run lint` — Lint with zero warnings
- `npm test` — Run tests (Vitest)
- `npm run test:coverage` — Tests with coverage
- `npm run test:tv` — Integration test against real TV endpoints
- `npm run start` — Build and launch Homebridge with test config
- `npm run watch` — Build, link, and watch with nodemon

## Project Structure

```
src/
├── index.ts                    # Plugin entry point
├── platform.ts                 # DynamicPlatformPlugin (multi-TV support)
├── platformAccessory.ts        # Individual TV accessory logic
├── settings.ts                 # Plugin constants
├── api/                        # Philips JointSpace API v6
│   ├── PhilipsTVClient.ts      # Main API client
│   ├── DigestAuthSession.ts    # Digest authentication
│   ├── constants.ts            # API endpoints
│   ├── types.ts                # Type definitions
│   └── utils.ts                # Helpers
└── services/                   # HomeKit service implementations
    ├── AmbilightService.ts     # Color control with Adaptive Lighting
    ├── InputSourceManager.ts   # Input source handling
    ├── NotifyChangeClient.ts   # Long-poll state detection
    ├── StatePollManager.ts     # Fallback interval polling
    └── StateSensorService.ts   # State sensors (MotionSensor-based)
test/
├── api/                        # API layer tests
├── services/                   # Service layer tests
└── hbConfig/                   # Sample Homebridge config
homebridge-ui/                  # Custom config UI with setup wizard
```

## Architecture

- **External accessories**: TVs published via `publishExternalAccessories()` (own HAP server)
- **Digest authentication** for JointSpace API v6 (Philips Android TVs 2016+)
- **Dual state detection**: Long-poll (`NotifyChangeClient`) with interval polling fallback
- **State sensors**: Expose power/ambilight/mute as MotionSensor services for automations
- **Adaptive Lighting**: Full support for HomeKit's Adaptive Lighting on Ambilight

## Code Style

- Single quotes, 2-space indent, semicolons required
- Trailing commas in multiline, max line length 160
- Unix line endings, object curly spacing

## Git Settings

- `coAuthoredBy`: false
