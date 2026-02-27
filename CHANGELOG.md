# Changelog

All notable changes to this project will be documented in this file.

## [1.0.9] - 2026-02-27

### Added

- **Long-poll support** (`NotifyChangeClient`): Connects to the TV's `/notifychange` endpoint for near-instant state change detection, with automatic fallback to interval polling
- **State sensors** (`StateSensorService`): Optional MotionSensor services for power, ambilight, and mute states — enables HomeKit automations triggered by TV state changes
- **Dynamic app discovery**: Automatically discovers all installed apps from the TV and adds them as input sources (up to 30 total), replacing the previous hard-coded app list
- **Source config support**: Applies visibility, order, and custom names from the Homebridge UI sources configuration
- **DisplayOrder TLV8 encoding**: Input sources are properly ordered in HomeKit using the TLV8 DisplayOrder characteristic
- Sample test config (`config.sample.json`) for development setup

### Changed

- **External accessory publishing**: TV accessories are now always published fresh as external accessories on each startup, fixing "Not Responding" issues caused by stale cached platform accessories
- **Quiet polling logs**: GET request/response debug logging removed from steady-state polling; only POST requests (user actions), errors, and actual state changes are logged
- **Change-detection logging**: StatePollManager now tracks previous values and only logs when power, volume, ambilight, or active app actually changes
- **Input source initialization**: `Active`, `ActiveIdentifier`, and `CurrentMediaState` characteristics are now set before handlers are registered, matching HAP best practices
- **Input source naming**: Uses `setCharacteristic()` to properly set ConfiguredName, fixing generic "Input Source #" names in HomeKit
- Increased max input sources from 15 to 30
- Input source names are sanitized for HomeKit compatibility
- Filters out system/launcher packages from auto-discovered apps

### Fixed

- Fixed "Not Responding" in HomeKit caused by cached platform accessories not being re-published as external accessories on restart
- Fixed input sources showing generic names ("Input Source", "Input Source 2") instead of real app/source names
- Fixed `CurrentVisibilityState.NOT_VISIBLE` TypeScript error — corrected to `HIDDEN`
- Fixed NotifyChange tight loop when TV pushes `activities/tv` every ~1 second — added minimum delay and filtered noise notifications

## [1.0.8] - 2026-02-27

### Added

- Unit test suite with 72 tests covering API utilities, TV client, and Ambilight color conversion
- Config validation for device entries (IP format, MAC format, required fields, polling interval range)
- Node.js version check at startup with warning for unsupported versions
- Vitest configuration and CI test step

### Changed

- **Digest auth caching**: Credentials are now sent proactively after the first 401 handshake, halving HTTP round-trips to the TV during steady-state polling
- Replaced `node-fetch` with native `fetch` via `undici` — fewer dependencies, same API
- Split 818-line `platformAccessory.ts` into focused modules: `AmbilightService`, `InputSourceManager`, `StatePollManager`
- Eliminated duplicated API code in `homebridge-ui/` — UI server now imports directly from `dist/api/`
- Simplified build script (removed file copy step)
- CI now uses `npm ci` with caching for faster, deterministic builds
- Removed unused `homebridge-lib` and `ts-node` dependencies

## [1.0.6] - 2026-02-27

### Added

- Debug logging for all API requests (method, endpoint, result, duration) visible in Homebridge debug mode (`-D`)

### Changed

- Reduced default API timeout from 5s to 2s to match pylips behavior — faster failure detection when TV is unreachable
- Enabled HTTP keep-alive on the HTTPS agent for connection reuse, matching pylips' session pooling behavior
- Merged v1.0.5 request serialization improvements

## [1.0.5] - 2026-02-27

### Fixed

- Serialized all API requests to the TV using a request queue to prevent overwhelming the JointSpace API server, which could crash under concurrent load ([#1](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/1))
- Added 100ms inter-request delay between consecutive API calls to give the TV time to process each request
- Delayed initial state polling by 5 seconds after accessory creation to let the TV API stabilize on startup
- Moved background app fetch after the first poll to avoid concurrent requests on startup

## [1.0.4] - 2026-02-27

### Fixed

- Fixed write handlers (`onSet`) for Active and On characteristics not responding within Homebridge's timeout window, causing "didn't respond at all!" warnings and slowing down the entire Homebridge instance ([#1](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/1))
- Reduced default API request timeout from 15s to 5s to fit within Homebridge's ~10s handler deadline
- Reduced Wake-on-LAN delay from 2s to 1s for faster power-on response
- All `onSet` handlers now properly catch errors and throw `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` so HomeKit shows a clear "Not Responding" status instead of hanging indefinitely

## [1.0.3] - 2025-01-19

### Added

- **Ambilight color control**: Ambilight now appears as a color lightbulb in HomeKit with full HSB control
  - Brightness slider (0-100%)
  - Color wheel with hue and saturation
  - Real-time color sync from TV to HomeKit
- **New Ambilight API methods**:
  - `getAmbilightStyle()` - Get current Ambilight configuration
  - `setAmbilightStyle()` - Set style (OFF, FOLLOW_VIDEO, FOLLOW_AUDIO, FOLLOW_COLOR)
  - `setAmbilightFollowVideo()` - Follow Video mode with sub-styles (Standard, Natural, Game, etc.)
  - `setAmbilightFollowAudio()` - Follow Audio mode with algorithms (VU Meter, Spectrum, Party, etc.)
  - `setAmbilightFollowColor()` - Static color mode with custom HSB values
  - `setAmbilightLounge()` - Lounge light presets (Hot Lava, Deep Water, etc.)
  - `setAmbilightBrightness()` - Brightness control (0-10)
  - `setAmbilightSaturation()` - Saturation control (0-10)
  - `getAmbilightTopology()` - Get LED layout information
- **New Ambilight types**: Full TypeScript support for Ambilight styles, colors, and configurations

### Changed

- Ambilight service upgraded from simple on/off to full color lightbulb
- Refactored magic numbers to named constants for better maintainability
- Enhanced state polling to sync Ambilight color when in FOLLOW_COLOR mode

## [1.0.2] - 2024-12-23

### Fixed

- Fixed plugin name in settings.ts to match scoped package name (`@mp-consulting/homebridge-philips-ambilight-tv`)
- Updated dependencies to reduce security vulnerabilities

## [1.0.1] - 2024-12-23

### Fixed

- Fixed Homebridge timeout warnings ("read handler didn't respond at all") by returning cached state immediately from all `onGet` handlers instead of making synchronous API calls
- Enhanced state polling to also track mute state and current input/activity
- Added `isMuted` cached state property for faster mute status responses

## [1.0.0] - 2024-12-20

### Added

- Initial release
- Power ON/OFF control with Wake-on-LAN support
- Input source selection (HDMI ports, TV tuner, applications)
- Volume control and mute functionality
- Remote control support (D-Pad, Back, Menu, Play/Pause, Info)
- Ambilight power control
- Multi-TV support in a single platform
- Custom UI for Homebridge Config UI X:
  - TV discovery via mDNS (Bonjour)
  - Guided pairing wizard with PIN entry
  - Source editor with drag-and-drop reordering
  - Source visibility toggle
  - MAC address auto-detection
- JointSpace API v6 client for Philips Android TVs
- Digest authentication support
- Input source persistence across restarts
- Workaround for tvOS 18 HomeHub input source renaming bug
- Comprehensive error handling and logging

### Technical

- TypeScript codebase with ESM modules
- Separate API client library (`PhilipsTVClient`)
- Shared code between plugin and custom UI
- ESLint configuration with strict rules
- Test script for TV API endpoints
