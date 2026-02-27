# Philips Smart TV API Reference

> Extracted from the official Philips Smart TV Android app (v3.0.83, package `com.tpvision.philipstvapp2` by TP Vision Europe B.V.) via APK decompilation.

## Connection

| Parameter | Value |
|-----------|-------|
| Protocol | HTTPS (self-signed certificate) |
| Port | `1926` (HTTPS with digest auth) |
| Fallback Port | `1925` (HTTP, used when HTTPS fails) |
| Auth | HTTP Digest Authentication (MD5) |
| Base URL | `https://<tv-ip>:1926/{version}` |
| API Versions | v1, v5, v6 (v6 is primary for modern TVs) |

## Authentication

### Digest Auth

The app uses standard HTTP Digest Authentication with:
- **Algorithm:** MD5
- **QoP:** auth
- **Fields:** realm, nonce, qop, cnonce, nc, opaque
- **Class:** `DigestAuthenticator.java`
- **Pairing type:** `digest_auth_pairing`

### Pairing Flow

| Step | Method | Endpoint | Description |
|------|--------|----------|-------------|
| 1 | POST | `/pair/request` | Initiate pairing, TV shows PIN |
| 2 | POST | `/pair/grant` | Submit PIN + HMAC signature |
| 3 | POST | `/pair/grant_new` | Alternative grant flow (newer TVs) |

#### Pair Request Payload

```json
{
  "scope": ["read", "write", "control"],
  "device": {
    "device_name": "<name>",
    "device_os": "Android",
    "app_name": "<app_name>",
    "type": "native",
    "app_id": "<app_id>",
    "id": "<device_id>"
  }
}
```

#### Pair Grant Payload

```json
{
  "auth": {
    "auth_appId": "<app_id>",
    "auth_timestamp": <timestamp>,
    "auth_signature": "<hmac_sha1_signature>",
    "pin": "<pin>"
  },
  "device": { ... }
}
```

**Response fields:** `auth_key`, `timestamp`

## Power

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/powerstate` | Get current power state |
| POST | `/powerstate` | Set power state |

```json
// GET response / POST body
{ "powerstate": "On" | "Standby" }
```

### Wake on LAN

The app sends **burst** magic packets:
- `MAGIC_PACKET_BURST_COUNT` bursts
- `MAGIC_PACKET_COUNT_IN_BURST` packets per burst
- `MAGIC_PACKET_BURST_INTERVAL` delay between bursts
- `WOW_MAGIC_PACKETS_SENT_DELAY` delay after sending
- Sent to UDP broadcast `255.255.255.255:9`
- Checks `ENABLE_WAKE_ON_LAN_SUPPORT` and WoLAN state via `TvWolanState`

## Volume / Audio

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/audio/volume` | Get volume state |
| POST | `/audio/volume` | Set volume/mute |

```json
// GET response
{ "current": 15, "min": 0, "max": 60, "muted": false }

// POST body (set volume)
{ "current": 15, "muted": false }

// POST body (toggle mute)
{ "muted": true }
```

## Screen State

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/screenstate` | Get screen on/off state |
| POST | `/screenstate` | Set screen state |

**States:** managed by `TvScreenState.SCREENSTATE` enum.

## System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/system` | Get system info (model, name, version, etc.) |
| GET | `/system/deviceid_encrypted` | Get encrypted device ID |
| GET | `/system/serialnumber_encrypted` | Get encrypted serial number |
| GET | `/startupstate` | Get startup state |

## Ambilight

### Core Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/ambilight/power` | Get ambilight power state |
| POST | `/ambilight/power` | Set ambilight power (`On`/`Off`) |
| GET | `/ambilight/mode` | Get current ambilight mode |
| POST | `/ambilight/mode` | Set ambilight mode |
| GET | `/ambilight/topology` | Get LED layout (layers, left, top, right, bottom) |
| GET | `/ambilight/currentconfiguration` | Get current style/algorithm config |
| POST | `/ambilight/currentconfiguration` | Set style/algorithm config |
| GET | `/ambilight/supportedstyles` | Get all supported ambilight styles |
| GET | `/ambilight/cached` | Get cached ambilight pixel data |
| GET | `/ambilight/measured` | Get measured ambilight colors |
| GET | `/ambilight/processed` | Get processed ambilight colors |
| POST | `/ambilight/lounge` | Set lounge light mode |
| GET/POST | `/ambilight/cnmode` | CN mode control |

### Ambilight Configuration Payload

```json
// POST /ambilight/currentconfiguration
{
  "styleName": "FOLLOW_VIDEO" | "FOLLOW_AUDIO" | "FOLLOW_COLOR" | "FOLLOW_FLAG" | "Lounge light" | "OFF",
  "isExpert": true,
  "algorithm": "<algorithm_name>",
  "speed": 0,
  "colorSettings": {
    "color": { "hue": 0, "saturation": 255, "brightness": 255 },
    "colorDelta": { "hue": 0, "saturation": 0, "brightness": 0 },
    "speed": 0
  }
}
```

### Style Names & Algorithms

| Style (`styleName`) | Algorithms (`algorithm`) |
|---------------------|-------------------------|
| `FOLLOW_VIDEO` | `STANDARD`, `NATURAL`, `FOOTBALL`, `VIVID`, `GAME`, `COMFORT`, `RELAX` |
| `FOLLOW_AUDIO` | `ENERGY_ADAPTIVE_BRIGHTNESS`, `ENERGY_ADAPTIVE_COLORS`, `VU_METER`, `SPECTRUM_ANALYZER`, `KNIGHT_RIDER_CLOCKWISE`, `KNIGHT_RIDER_ALTERNATING`, `RANDOM_PIXEL_FLASH`, `PARTY` |
| `FOLLOW_COLOR` | `MANUAL_HUE`, `AUTOMATIC_HUE` |
| `FOLLOW_FLAG` | *(flag-specific algorithms)* |
| `Lounge light` | *(lounge light presets)* |
| `OFF` | *(none)* |

### Ambilight Settings via Menu System

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/menuitems/settings/current` | Read current setting values by node ID |
| POST | `/menuitems/settings/update` | Update a setting by node ID |
| GET | `/menuitems/settings/structure` | Get full menu tree structure |

```json
// POST /menuitems/settings/update
{
  "values": [{
    "value": {
      "Nodeid": 2131230769,
      "data": { "value": 7 }
    }
  }]
}
```

**Known ambilight node IDs:**
- Brightness: `2131230769`
- Saturation: `2131230771`
- Range: `0-10`

## Input / Remote Control

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/input/key` | Send a remote key press |
| POST | `/input/textentry` | Send text input |
| GET | `/input/onscreenkeyboard/visible` | Check on-screen keyboard visibility |

### Key Names

```json
// POST /input/key
{ "key": "<key_name>" }
```

**Available keys:**
`Standby`, `PowerOn`, `PowerOff`, `Back`, `Find`, `RedColour`, `GreenColour`, `YellowColour`, `BlueColour`, `Home`, `VolumeUp`, `VolumeDown`, `Mute`, `Options`, `Dot`, `Digit0`-`Digit9`, `Info`, `CursorUp`, `CursorDown`, `CursorLeft`, `CursorRight`, `Confirm`, `Next`, `Previous`, `Adjust`, `WatchTV`, `Viewmode`, `Teletext`, `Subtitle`, `ChannelStepUp`, `ChannelStepDown`, `Source`, `AmbilightOnOff`, `PlayPause`, `Play`, `Pause`, `Stop`, `FastForward`, `Rewind`, `Record`, `Online`

## Activities / Applications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/activities/current` | Get current activity (v6) |
| GET | `/1/activities/current` | Get current activity (v1) |
| POST | `/activities/launch` | Launch an application |
| POST | `/activities/tv` | Switch to TV activity |
| GET | `/applications` | Get installed application list |

### Launch App Payload

```json
// POST /activities/launch
{
  "intent": {
    "component": {
      "packageName": "com.google.android.youtube.tv",
      "className": "com.google.android.youtube.tv.MainActivity"
    },
    "action": "android.intent.action.MAIN"
  }
}
```

### Switch to TV Channel

```json
// POST /activities/tv
{
  "channel": { "ccid": 123 },
  "channelList": { "id": "allcab" }
}
```

**Channel list IDs:** `allcab` (all cable), `allter` (all terrestrial), `allsat` (all satellite)

## Channels

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/channeldb/tv` | Get full channel database |
| GET | `/channeldb/tv/channelLists/` | Get channel lists |
| GET | `/channeldb/tv/channelLists/all` | Get all channels |
| GET | `/channeldb/tv/favoriteLists/` | Get favorite channel lists |
| POST | `/channeldb/tv/modifyfavourite/` | Modify favorites |
| GET | `/1/channels/current` | Get current channel (v1) |
| GET | `/1/channellistsEx` | Get extended channel lists (v1) |

## Sources

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sources` | Get available input sources |

## TV Setup

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tvsetup/status` | Get setup status |
| GET | `/tvsetup/location` | Get location settings |
| GET | `/tvsetup/postalcode` | Get postal code |
| GET | `/tvsetup/networkinfo` | Get network info |
| GET | `/tvsetup/networkconfig_encrypted` | Get encrypted network config |
| GET/POST | `/tvsetup/channellock` | Channel lock settings |
| GET/POST | `/tvsetup/wideareacode` | Wide area code |

## Localization

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/strings` | Get localized UI strings |

## Event Notification (Long Polling)

The app uses **POST long-polling** on `/notifychange` endpoints to receive real-time updates instead of polling.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/6/notifychange` | Subscribe to v6 events |
| POST | `/5/notifychange` | Subscribe to v5 events |
| POST | `/1/notifychange` | Subscribe to v1 events |

The function `listenForTVEventsAndNotify()` posts to the endpoint and blocks until the TV sends a notification response. Falls back to HTTP port 1925 if HTTPS fails.

## Aurora (Ambient Mode / Screensaver)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/aurora/settings/current` | Get current aurora settings |
| POST | `/aurora/settings/update` | Update aurora settings |
| GET | `/aurora/settings/gallery` | Get gallery items |
| GET | `/aurora/settings/aiart` | Get AI art settings |
| GET | `/aurora/settings/isopen` | Check if aurora is active |
| GET | `/aurora/settings/structure` | Get aurora menu structure |

## Matter (Smart Home Protocol)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/matter/paircode` | Get Matter pairing code |
| GET | `/matter/pairstatus` | Get Matter pairing status |

## Hue Bridge Integration

The app directly communicates with Philips Hue bridges:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config` | Hue bridge config |
| GET | `/api/nupnp` | Bridge portal discovery |
| * | `/lights/` | Light control |
| * | `/groups/` | Group control |
| * | `/scenes/` | Scene control |
| * | `/rules/` | Rule management |
| * | `/schedules/` | Schedule management |
| * | `/sensors/` | Sensor data |

## Cloud Services

| URL | Purpose |
|-----|---------|
| `https://prod.tpvdevices.com/` | Production device cloud |
| `https://acc.tpvdevices.com/` | Staging/acceptance device cloud |
| `https://ptaprod.nettvservices.com/` | NetTV production services |
| `https://ptaacc.nettvservices.com/` | NetTV acceptance services |
| `https://tou.zeasn.tv/tou/status/` | Terms of use status |
| `http://rec.zeasn.tv/api/work/` | Recommendation engine |

## Network Discovery

| Method | Description |
|--------|-------------|
| GET `/1/network/devices` | Discover devices on network (v1) |
| mDNS/NSD | `javax.jmdns` for local service discovery |
| QR Code | Camera-based pairing via QR scan |
