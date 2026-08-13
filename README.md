# Homebridge Tapo Plugin

A Homebridge plugin for controlling TP-Link Tapo smart devices that are not Matter compatible or exposed by the Matter hub.

## Features

- **Full HomeKit Integration**: Control your Tapo devices through the Home app, Siri, and automation
- **Custom Configuration UI**: Easy-to-use web interface for device discovery and setup
- **Automatic Device Discovery**: Scan your network to find all Tapo devices  
- **Encrypted Credentials**: Secure storage of your TP-Link account credentials  
- **Secret Request Support**: Optional credential-free operation via iPhone push notifications (never stores credentials on disk)
- **Device Selection**: Choose which devices to expose to HomeKit with visual device cards
- **Tapo L430C Support**: RGB color bulbs with full brightness, color, and color temperature control
- **KLAP Protocol**: Uses the latest KLAP authentication protocol for secure communication
- **Status Polling**: Regular updates to keep HomeKit in sync with physical device state
- **IR Remote Support (H110 Hub)**: Control paired IR remotes (TVs, speakers, etc.) through the Home app as HomeKit Televisions — fully cloud-based, no LAN access or device password needed

## Supported Devices

- **L430C** - Smart Wi-Fi Light Bulb, Multicolor
  - Power on/off
  - Brightness (1-100%)
  - RGB Color (Hue 0-360°, Saturation 0-100%)  
  - Color Temperature (2500K-6500K)
- **IR Remote (Tapo H110 Hub)** - any IR remote paired in the Tapo app
  - Exposed as a HomeKit **Television** with a **TelevisionSpeaker**
  - Power on/off (POWER key) via the TV Active characteristic
  - Volume up/down and mute via the speaker's volume control
  - One **Input Source** per IR key (e.g. Bluetooth, OPT, LINE1, PLAY...) — selecting one fires the IR command
  - Controlled through the Tapo Cloud Thing API (the same path the mobile app uses), so it works over the internet with no LAN setup

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

### Using the Custom UI (Recommended)

The plugin includes a custom configuration interface that makes setup easy:

1. **Install the plugin** via Homebridge Config UI X
2. **Click "Settings"** on the plugin card
3. **Enter your TP-Link credentials** (email and password)
4. **Click "Discover Devices"** - the plugin will scan your network
5. **Select devices** you want to add by clicking on their cards
6. **Adjust settings** like polling interval if needed
7. **Click "Save Configuration"** - Homebridge will restart automatically

**Features of the Custom UI:**
- 🔍 Automatic network scanning for Tapo devices
- 💾 Encrypted credential storage (no plaintext passwords)
- 📱 Visual device cards with emojis and status indicators
- ⚡ Real-time device discovery with loading states
- 🎨 Modern, responsive design

### Manual Configuration

If you prefer to edit the config file directly, add this to your Homebridge `config.json`:

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
        },
        {
          "name": "Edifier S2000 Mark III",
          "type": "ir-remote",
          "thingName": "802D3E1478A92CEA8BF45E3034FE94D9237E02B7030B0002",
          "irKeys": ["LINE1", "LINE2", "Bluetooth", "OPT", "Coax", "Classic", "DYNAMIC", "VOCAL", "MONITOR"],
          "irLabels": {
            "POWER": "Power",
            "VOL+": "Volume Up",
            "VOL-": "Volume Down",
            "MUTE": "Mute",
            "PLAY": "Play",
            "PAUSE": "Pause",
            "NEXT": "Next",
            "PREVIOUS": "Previous",
            "LINE1": "Line 1",
            "LINE2": "Line 2",
            "Bluetooth": "Bluetooth",
            "OPT": "Optical",
            "Coax": "Coaxial",
            "Classic": "Classic",
            "DYNAMIC": "Dynamic",
            "VOCAL": "Vocal",
            "MONITOR": "Monitor"
          }
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
| `email` | Yes | Your TP-Link/Tapo account email (will be encrypted when using custom UI) |
| `password` | Yes | Your TP-Link/Tapo account password (will be encrypted when using custom UI) |
| `isEncrypted` | No | Indicates if credentials are encrypted (automatically set by custom UI) |
| `pollingInterval` | No | How often to poll devices for updates in seconds (default: 30, range: 10-300) |
| `devices` | Yes | Array of device configurations |

**Note:** The custom UI encrypts credentials using AES-256-GCM with a key derived from your Homebridge bridge credentials (MAC + PIN). This makes the encryption unique per installation.

#### IR Remote configuration

IR remotes are paired in the Tapo app under an **H110 hub** and are exposed by
the plugin as HomeKit **Televisions**. They are controlled entirely through the
Tapo Cloud Thing API — no `ip` or device password is needed.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Must match the remote's nickname in the Tapo app (e.g. "Edifier S2000 Mark III") |
| `type` | Yes | `"ir-remote"` |
| `thingName` | No | The remote's cloud thingName (printed in the plugin log during discovery). Use it to disambiguate when you have multiple remotes with similar names |
| `irKeys` | No | Optional list of IR **source** key names to expose as HomeKit inputs (e.g. `LINE1`, `LINE2`, `Bluetooth`, `OPT`, `Coax`). Omit to expose all source keys the remote reports. Power/volume/mute/transport keys are never inputs |
| `irButtons` | No | Optional list of IR key names to expose as **Switch buttons** (tap to fire), e.g. `["VOL+","VOL-","PLAY","PAUSE"]`. Disabled by default. Warning: enabling them makes Home app switch from the native TV input/speaker UI to a generic tile layout. Mute is not a button — it lives on the speaker's mute control |
| `irLabels` | No | Optional display-name overrides keyed by IR key name, e.g. `{ "OPT": "Optical", "LINE1": "Line 1" }`. Without this, labels are auto-cased (`LINE1` → `Line 1`, `BLUETOOTH` → `Bluetooth`) |

To find your remote's `thingName`, enable debug logging and look for the
`[IR Remote]` lines on startup — they list every remote found on the account
with its `thingName`.

**HomeKit mapping:**
- TV power (Active) → `POWER` key
- Volume + **mute** (TelevisionSpeaker) → `VOL+` / `VOL-` / `MUTE` via the speaker's volume slider on the TV page
- **Source keys** (Line 1, Line 2, Bluetooth, OPT, ...) become **Input Sources**; selecting one in the Home app fires its IR command
- **Buttons** are disabled by default to preserve the native TV layout. If you set `irButtons`, those keys become **Switch buttons** on the accessory — tap to fire, but Home app will switch to a generic tile layout
- Navigation keys are not exposed (no HomeKit home for them)

> **After updating the plugin**, remove the accessory from the Home app and
> re-add it — the set of services changed, and HomeKit won't pick up removed
> inputs from an already-paired accessory.

### Secret Request Mode (Advanced)

For enhanced security, the plugin supports **Secret Request** - a credential delivery method that never stores your Tapo credentials on disk. Instead, credentials are delivered via push notification to your iPhone when Homebridge starts.

#### How Secret Request Works

1. On Homebridge startup, the plugin requests credentials from the secret-request server
2. You receive a push notification on your iPhone
3. Tap "Allow" to approve and deliver the credentials
4. Credentials are held in memory only (never written to disk)
5. If Homebridge restarts, the process repeats

#### Prerequisites

- **secret-request-ios server** running (see [secret-request-ios](https://github.com/stoyanov-x/secret-request-ios))
- **iOS Shortcuts/Scriptable** setup with credentials stored in iOS Keychain
- **VPN or local network** access between Homebridge and secret-request server

#### Setup Instructions

**1. Start the secret-request server:**

```bash
cd /path/to/secret-request-ios/server
docker-compose up -d --build
```

**2. Store your Tapo credentials in iOS Keychain:**

Using the Scriptable SecretRequest script:
- Open Scriptable app on your iPhone
- Run the SecretRequest script
- Select "Store Multi-Part Secret"
- Name: `tapo-admin`
- Fields:
  - `email`: your-tapo-email@example.com
  - `password`: your-tapo-password

**3. Configure the plugin to use Secret Request:**

Via Custom UI:
1. Open plugin settings
2. Select "Secret Request (iPhone Push)" as credential method
3. Enter secret name: `tapo-admin`
4. Server URL: `http://localhost:8420` (or your server address)
5. Timeout: `12` hours (configurable 1-48 hours)
6. Add devices manually by IP address (discovery isn't available without credentials)
7. Save configuration

Or manually in `config.json`:

```json
{
  "platform": "TapoStoyanov",
  "name": "Tapo Platform",
  "credentialType": "secret-request",
  "secretName": "tapo-admin",
  "secretServerUrl": "http://localhost:8420",
  "secretTimeout": 43200,
  "pollingInterval": 30,
  "devices": [
    {
      "name": "Living Room Light",
      "ip": "192.168.1.100",
      "type": "light"
    }
  ]
}
```

**4. Restart Homebridge**

Devices will appear in HomeKit immediately but show "No Response" until you approve the secret request on your iPhone.

#### Configuration Options (Secret Request Mode)

| Field | Required | Description |
|-------|----------|-------------|
| `credentialType` | Yes | Must be `secret-request` |
| `secretName` | Yes | Name of the secret stored in iOS Keychain (e.g., `tapo-admin`) |
| `secretServerUrl` | Yes | URL of the secret-request server (default: `http://localhost:8420`) |
| `secretTimeout` | No | Seconds to wait for secret approval (default: 43200 = 12 hours, range: 3600-172800) |
| `secretApiKey` | No | API key for server authentication (can also use `SECRET_API_KEY` environment variable) |

#### Troubleshooting Secret Request

**Devices show "No Response" after Homebridge restart:**
- Check Homebridge logs for `[SecretRequest]` messages
- Verify secret-request server is running: `curl http://localhost:8420/health`
- Check your iPhone for pending push notifications (ntfy app)
- Ensure secret name matches: `tapo-admin`
- Verify credentials are stored in iOS Keychain (run Scriptable script → "List Secrets")

**Request times out:**
- Default timeout is 12 hours - you have plenty of time to approve
- Check ntfy notifications are enabled on your iPhone
- Ensure VPN is active if server is not on local network

**How to switch back to Traditional mode:**
- Open plugin settings
- Select "Traditional (TP-Link Account)" 
- Enter your credentials
- Save - old secret-request settings will be removed automatically

### Device Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Friendly name for the device in HomeKit |
| `ip` | Yes | Local IP address of the device |
| `type` | Yes | Device type (currently only `light` is supported) |
| `mac` | No | Device MAC address (automatically populated by discovery) |
| `model` | No | Device model (automatically populated by discovery) |

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
research/test_device.sh
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
