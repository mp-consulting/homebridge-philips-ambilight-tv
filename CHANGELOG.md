# Changelog

All notable changes to this project will be documented in this file.

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
