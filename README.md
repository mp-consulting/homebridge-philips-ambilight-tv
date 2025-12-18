<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge Philips Ambilight TV

This plugin allows you to control your Philips Ambilight TV as a HomeKit Television accessory.

## Features

- Power ON/OFF
- Input Source Selection
- Volume Control
- Remote Control (D-Pad, Back, Menu, etc.)

## Installation

1. Install Homebridge using: `npm install -g homebridge`
2. Install this plugin using: `npm install -g homebridge-philips-ambilight-tv`
3. Update your configuration file.

## Configuration

Add the following to your `config.json` file:

```json
{
    "platforms": [
        {
            "platform": "PhilipsAmbilightTV",
            "name": "Philips TV",
            "ip": "192.168.1.10",
            "mac": "AA:BB:CC:DD:EE:FF",
            "username": "your_username",
            "password": "your_password"
        }
    ]
}
```

### Configuration Options

| Key | Description | Default |
| --- | --- | --- |
| `platform` | Must be `PhilipsAmbilightTV` | - |
| `name` | Name of the accessory | "Philips TV" |
| `ip` | IP address of your TV | - |
| `mac` | MAC address of your TV | - |
| `pin` | PIN code for pairing | - |
| `username` | Username for authentication | - |
| `password` | Password for authentication | - |

## Development

1. Clone the repository.
2. Run `npm install` to install dependencies.
3. Run `npm run build` to build the plugin.
4. Run `npm run watch` to start the plugin in development mode.
