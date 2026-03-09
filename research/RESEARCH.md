# Tapo L430C Research Findings

## Device Testing Summary

**Date**: March 9, 2026  
**Device**: Tapo L430C Smart Wi-Fi Light Bulb  
**Testing Tool**: PyTapo (Python library)

## Connection Details

- **Protocol**: KLAP (Key-based Local Authentication Protocol)
- **Port**: HTTP on port 80 (NOT HTTPS on port 443)
- **Authentication**: TP-Link account email/password
- **Communication**: Encrypted with AES-128-CBC after handshake

## Device Capabilities

### Basic Information
- **Model**: L430C
- **Type**: SMART.TAPOBULB
- **Hardware Version**: 1.0
- **Firmware Version**: 1.0.4 Build 241018 Rel.092847

### Supported Features

✅ **Power Control**
- Turn on/off
- Command: `set_device_info` with `{"device_on": true/false}`

✅ **Brightness Control**
- Range: 1-100%
- Command: `set_device_info` with `{"brightness": value}`

✅ **Color Temperature Control**
- Range: 2500K - 6500K
- Command: `set_device_info` with `{"color_temp": value, "hue": 0, "saturation": 0}`

✅ **RGB Color Control**
- Hue: 0-360°
- Saturation: 0-100%
- Command: `set_device_info` with `{"hue": value, "saturation": value, "color_temp": 0}`

### API Methods

#### Getting Device State
```python
info = bulb.getBasicInfo()
```

Returns:
```json
{
  "device_on": true,
  "brightness": 95,
  "hue": 0,
  "saturation": 0,
  "color_temp": 2700,
  "color_temp_range": [2500, 6500],
  "model": "L430C",
  "mac": "...",
  "ip": "...",
  ...
}
```

#### Setting Device State
```python
bulb.executeFunction("set_device_info", params)
```

Example parameters:
- Power: `{"device_on": true}`
- Brightness: `{"brightness": 75}`
- Color Temp: `{"color_temp": 4000}`
- RGB Color: `{"hue": 240, "saturation": 100, "color_temp": 0}`
- White: `{"hue": 0, "saturation": 0, "color_temp": 2700}`

## KLAP Protocol Implementation

### Authentication Flow

1. **Handshake1**: Client sends 16-byte local seed
   - POST `/app/handshake1` with random bytes
   - Receive remote seed and session cookie

2. **Handshake2**: Client sends authentication hash
   - Calculate: SHA256(SHA256(email + password))
   - Send: SHA256(localSeed + remoteSeed + authHash)
   - Verify: SHA256(remoteSeed + localSeed + authHash)

3. **Session Key Generation**
   - sessionKey = SHA256("lsk" + localSeed + remoteSeed + authHash)

### Request/Response Encryption

**Encryption** (AES-128-CBC):
- Key: First 16 bytes of sessionKey
- IV: Derived from sequence number and sessionKey
- Each request increments sequence counter
- Signature: SHA256(key + encryptedData)

**Request Format**:
- POST `/app/request?seq={sequence}`
- Body: signature (32 bytes) + encrypted payload

**Response Format**:
- signature (32 bytes) + encrypted payload
- Verify signature before decryption

## Test Results

All device control tests passed successfully:

- ✅ Turn ON/OFF
- ✅ Set Brightness (tested: 50%)
- ✅ Set Color Temperature (tested: 4000K)
- ✅ Set RGB Color Blue (H:240, S:100)
- ✅ Set RGB Color Red (H:0, S:100)
- ✅ Back to Warm White (2700K)

Response Time: Typical latency under 100ms

## HomeKit Mapping

| Tapo Feature | HomeKit Characteristic | Conversion |
|--------------|------------------------|------------|
| device_on | On | Direct boolean |
| brightness | Brightness | Direct (1-100%) |
| color_temp | ColorTemperature | Kelvin ↔ Mired (1000000/value) |
| hue | Hue | Direct (0-360°) |
| saturation | Saturation | Direct (0-100%) |

## Implementation Notes

1. **Color Mode Switching**: 
   - Set `color_temp: 0` when using RGB (hue/saturation)
   - Set `hue: 0, saturation: 0` when using color temperature

2. **Batch Updates**:
   - Multiple parameters can be set in one `set_device_info` call
   - Useful for brightness + color changes

3. **Session Management**:
   - Sessions persist for 24 hours
   - Re-authenticate on 403 errors
   - Keep cookie for all requests after handshake

4. **Error Handling**:
   - `error_code: 0` means success
   - Non-zero error codes indicate failure

## Future Enhancements

Potential additions for future versions:
- Support for other Tapo bulb models (L530, L630, etc.)
- Support for Tapo LED strips
- Support for Tapo smart plugs with power monitoring
- Support for Tapo sensors (contact, motion, temperature)
- Dynamic light effects support
- Scene/preset support

## References

- PyTapo: https://github.com/JurajNyiri/pytapo
- Retired plugin: https://github.com/RaresAil/homebridge-tp-link-tapo
- Homebridge API: https://developers.homebridge.io/
