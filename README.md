# Homebridge Tapo Plugin

A Homebridge plugin for controlling TP-Link Tapo smart devices that are not Matter compatible or exposed by the Matter hub.

## Features

- **Full HomeKit Integration**: Control your Tapo devices through the Home app, Siri, and automation
- **Tapo L430C Support**: RGB color bulbs with full brightness, color, and color temperature control
- **KLAP Protocol**: Uses the latest KLAP authentication protocol for secure communication
- **Automatic Discovery**: Configure devices by IP address
- **Status Polling**: Regular updates to keep HomeKit in sync with physical device state

## Supported Devices

- **L430C** - Smart Wi-Fi Light Bulb, Multicolor
  - Power on/off
  - Brightness (1-100%)
  - RGB Color (Hue 0-360°, Saturation 0-100%)  
  - Color Temperature (2500K-6500K)

Future devices may include sensors and other Tapo products.

## Installation

### Via Homebridge Config UI X (Recommended)

1. Search for "homebridge-tapo-stoyanov" in the Homebridge Config UI X plugin search
2. Click **Install**
3. Configure the plugin (see Configuration below)

### Manual Installation

```bash
npm install -g homebridge-tapo-stoyanov
```

## Configuration

Add the platform to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "TapoStoyanov",
      "name": "Tapo Platform",
      "email": "your-tapo-account@example.com",
      "password": "your-tapo-password",
      "pollingInterval": 30,
      "devices": [
        {
          "name": "Living Room Light",
          "ip": "192.168.1.100",
          "type": "light"
        },
        {
          "name": "Bedroom Light",
          "ip": "192.168.1.101",
          "type": "light"
        }
      ]
    }
  ]
}
```

### Configuration Options

| Field | Required | Description |
|-------|----------|-------------|
| `platform` | Yes | Must be `TapoStoyanov` |
| `name` | No | Display name for the platform (default: "Tapo Platform") |
| `email` | Yes | Your TP-Link/Tapo account email |
| `password` | Yes | Your TP-Link/Tapo account password |
| `pollingInterval` | No | How often to poll devices for updates in seconds (default: 30, range: 10-300) |
| `devices` | Yes | Array of device configurations |

### Device Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Friendly name for the device in HomeKit |
| `ip` | Yes | Local IP address of the device |
| `type` | Yes | Device type (currently only `light` is supported) |

## How It Works

This plugin communicates directly with your Tapo devices over your local network using:

1. **KLAP Protocol**: Latest Tapo authentication protocol for secure device communication
2. **HTTP API**: Devices are accessed via HTTP on port 80 (not HTTPS)
3. **TP-Link Account**: Uses your Tapo app credentials for authentication
4. **Status Polling**: Regularly checks device state to keep HomeKit synchronized

### Protocol Details

The plugin implements the KLAP (Key-based Local Authentication Protocol):
- Handshake process with local and remote seeds
- SHA-256 based authentication
- AES-128-CBC encryption for all communications
- Session management with automatic re-authentication

## Testing Your Device

Before setting up the Homebridge plugin, you can test if your Tapo device is compatible:

```bash
./research/test_device.sh
```

The script will prompt you for your device IP, email, and password, then run comprehensive tests. See [research/README.md](research/README.md) for details.

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/stoyanov-x/homebridge-tapo-stoyanov.git
cd homebridge-tapo-stoyanov

# Install dependencies
npm install

# Build
npm run build

# Link for local development
npm link
```

## Troubleshooting

### Device Not Responding

1. **Check Network Connection**: Ensure the device is on the same network as Homebridge
2. **Verify IP Address**: The device must have a static IP or DHCP reservation
3. **Test Connectivity**: Ping the device to confirm it's reachable
4. **Check Credentials**: Ensure your TP-Link account email/password are correct

### Authentication Errors

- The plugin uses your TP-Link cloud account credentials
- Make sure you can log into the Tapo app with these credentials
- Some users report needing to enable/disable the device in the Tapo app first

### Logs

Enable debug logging in Homebridge to see detailed communication:
- Check Homebridge logs for error messages
- Look for "Authentication failed" or "Connection refused" errors

## Credits

- Inspired by [homebridge-tp-link-tapo](https://github.com/RaresAil/homebridge-tp-link-tapo) (now retired)

## License

MIT License - see LICENSE file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and feature requests, please use the [GitHub Issues](https://github.com/stoyanov-x/homebridge-tapo-stoyanov/issues) page.
