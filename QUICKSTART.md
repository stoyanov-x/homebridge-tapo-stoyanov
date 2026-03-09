# Quick Start

## 1. Test Device (Optional)
```bash
./research/test_device.sh
```

## 2. Install Plugin
Via Homebridge Config UI X, search "homebridge-tapo-stoyanov" and install.

Or locally:
```bash
npm link
```

## 3. Configure
1. Click **Settings** on the plugin
2. Enter TP-Link credentials
3. Click **Discover Devices**
4. Select devices → **Save**

## 4. Test
- Home app: Look for your devices
- Siri: "Turn on [Device Name]"
- Logs: Check for "Initialized [name] at [IP]"

## Troubleshoot
- **Not found**: Verify IP, ping device
- **Auth errors**: Check credentials work in Tapo app
- **Debug**: Enable debug logging in Homebridge

See [README.md](README.md) for full documentation.
