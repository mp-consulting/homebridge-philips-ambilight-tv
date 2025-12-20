<p align="center">
<img src="homebridge-ui/public/ambilight-tv.jpg" width="300">
</p>

# Homebridge Philips Ambilight TV

A Homebridge plugin to control Philips Android TVs with Ambilight as HomeKit Television accessories.

## Features

- Power ON/OFF with Wake-on-LAN support
- Input source selection (HDMI, TV tuner, apps)
- Volume control and mute
- Remote control (D-Pad, Back, Menu, Play/Pause, etc.)
- Ambilight power control
- Multi-TV support
- Custom UI for easy setup and configuration

## Requirements

- Philips Android TV with JointSpace API v6 (2016+ models)
- TV and Homebridge on the same network
- Node.js 20.18.0 or later

## Installation

### Via Homebridge UI (Recommended)

1. Open the Homebridge UI
2. Go to the Plugins tab
3. Search for "homebridge-philips-ambilight-tv"
4. Click Install

### Via Command Line

```bash
npm install -g homebridge-philips-ambilight-tv
```

## Setup

### Using the Custom UI (Recommended)

1. Open the Homebridge UI and go to the plugin settings
2. Click "Discover TVs" to find your TV on the network
3. Select your TV and follow the pairing wizard
4. Enter the PIN displayed on your TV screen
5. Customize sources and save

### Manual Configuration

Add the following to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "PhilipsAmbilightTV",
      "devices": [
        {
          "name": "Living Room TV",
          "ip": "192.168.1.10",
          "mac": "AA:BB:CC:DD:EE:FF",
          "username": "your_device_id",
          "password": "your_auth_key"
        }
      ]
    }
  ]
}
```

### Configuration Options

| Key | Description | Required |
| --- | --- | --- |
| `platform` | Must be `PhilipsAmbilightTV` | Yes |
| `devices` | Array of TV configurations | Yes |
| `devices[].name` | Display name for the TV | Yes |
| `devices[].ip` | IP address of your TV | Yes |
| `devices[].mac` | MAC address (for Wake-on-LAN) | Yes |
| `devices[].username` | Device ID from pairing | Yes |
| `devices[].password` | Auth key from pairing | Yes |
| `devices[].sources` | Custom source configuration | No |

### Getting Credentials

The `username` and `password` are obtained during the pairing process:

1. Use the plugin's custom UI to pair (recommended)
2. Or use the TV's built-in pairing API:
   - Send a pairing request to `https://<TV_IP>:1926/6/pair/request`
   - Complete the pairing with the PIN shown on TV
   - The response contains your credentials

## Editing Sources

The plugin supports customizing which sources appear in HomeKit:

1. Go to the plugin settings in Homebridge UI
2. Click "Edit Sources" on your configured TV
3. Drag and drop to reorder sources
4. Toggle visibility for each source
5. Click "Done" to save

Note: HomeKit limits input sources to 45 total.

## Troubleshooting

### TV not discovered

- Ensure the TV is powered on (not in standby)
- Check that TV and Homebridge are on the same network/VLAN
- Try entering the IP address manually

### Pairing fails

- Make sure no other device is pairing simultaneously
- Try restarting the TV
- Check the TV's network settings

### TV not responding

- Verify the TV's IP hasn't changed (consider a static IP)
- Check if Wake-on-LAN is enabled in TV settings
- Ensure the TV's API is accessible (port 1926)

### Input sources not updating in Home app

This is a known tvOS 18 bug. The plugin includes a workaround that may require removing and re-adding the TV in the Home app.

## Development

```bash
# Clone the repository
git clone https://github.com/mickael/homebridge-philips-ambilight-tv.git

# Install dependencies
npm install

# Build
npm run build

# Run with test config
npm start

# Test TV endpoints
npm run test:tv
```

## License

Apache-2.0

## Credits

- [Homebridge](https://homebridge.io/)
- Philips JointSpace API documentation
