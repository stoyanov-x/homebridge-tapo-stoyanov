# Tapo Device Testing

This folder contains research tools for testing Tapo device capabilities.

## test_control.py

Comprehensive test script that verifies all L430C capabilities:
- Power control (On/Off)
- Brightness adjustment
- Color temperature control
- RGB color control

### Usage

#### Option 1: Using the test script (Recommended)

```bash
# From project root
./research/test_device.sh

# Or from research folder
cd research
./test_device.sh
```

The script will prompt you for:
- Device IP address
- Tapo account email
- Tapo account password

#### Option 2: With environment variables

```bash
export TAPO_DEVICE_IP="192.168.1.100"
export TAPO_EMAIL="your-email@example.com"
export TAPO_PASSWORD="your-password"

./research/test_device.sh
```

#### Option 3: Direct Python execution

```bash
# From project root
source research/venv/bin/activate
python3 research/test_control.py
deactivate

# Or from research folder
cd research
source venv/bin/activate
python3 test_control.py
deactivate
```

## Requirements

- Python 3.7+
- Virtual environment with PyTapo installed
- Tapo L430C device on the same network

## What it Tests

1. ✅ Device connection and authentication
2. ✅ Power ON/OFF commands
3. ✅ Brightness control (1-100%)
4. ✅ Color temperature (2500K-6500K)
5. ✅ RGB color (Hue 0-360°, Saturation 0-100%)
6. ✅ State verification after each command

All tests include verification to ensure commands were successful.
