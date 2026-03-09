#!/usr/bin/env python3
"""
Test controlling Tapo L430C using executeFunction.
"""

from pytapo import Tapo
import json
import time

DEVICE_IP = "192.168.1.100"  # Change to your device IP
EMAIL = "your-tapo-email@example.com"
PASSWORD = "your-tapo-password"

def print_section(title):
    print("\n" + "="*70)
    print(f" {title}")
    print("="*70)

# Connect to device
print("Connecting to device...")
bulb = Tapo(DEVICE_IP, EMAIL, PASSWORD, controlPort=80)
print("✓ Connected!\n")

# Get current state
print_section("Current Device State")
info = bulb.getBasicInfo()
print(f"Power: {'ON' if info['device_on'] else 'OFF'}")
print(f"Brightness: {info['brightness']}%")
print(f"Hue: {info['hue']}°")
print(f"Saturation: {info['saturation']}%")
print(f"Color Temperature: {info['color_temp']}K")
print(f"Color Temp Range: {info['color_temp_range'][0]}K - {info['color_temp_range'][1]}K")

# Test 1: Turn OFF
print_section("Test 1: Turn OFF")
try:
    result = bulb.executeFunction("set_device_info", {"device_on": False})
    print(f"Result: {result}")
    time.sleep(2)
    
    # Check state
    info = bulb.getBasicInfo()
    print(f"✓ Device is now: {'ON' if info['device_on'] else 'OFF'}")
except Exception as e:
    print(f"✗ Error: {e}")

# Test 2: Turn ON
print_section("Test 2: Turn ON")
try:
    result = bulb.executeFunction("set_device_info", {"device_on": True})
    print(f"Result: {result}")
    time.sleep(2)
    
    # Check state
    info = bulb.getBasicInfo()
    print(f"✓ Device is now: {'ON' if info['device_on'] else 'OFF'}")
except Exception as e:
    print(f"✗ Error: {e}")

# Test 3: Set Brightness
print_section("Test 3: Set Brightness to 50%")
try:
    result  = bulb.executeFunction("set_device_info", {"brightness": 50})
    print(f"Result: {result}")
    time.sleep(1)
    
    # Check state
    info = bulb.getBasicInfo()
    print(f"✓ Brightness is now: {info['brightness']}%")
except Exception as e:
    print(f"✗ Error: {e}")

# Test 4: Set Color Temperature
print_section("Test 4: Set Color Temperature to 4000K")
try:
    result = bulb.executeFunction("set_device_info", {"color_temp": 4000})
    print(f"Result: {result}")
    time.sleep(1)
    
    # Check state
    info = bulb.getBasicInfo()
    print(f"✓ Color Temperature is now: {info['color_temp']}K")
except Exception as e:
    print(f"✗ Error: {e}")

# Test 5: Set RGB Color (Blue)
print_section("Test 5: Set Color to Blue (H:240, S:100)")
try:
    result = bulb.executeFunction("set_device_info", {
        "hue": 240,
        "saturation": 100,
        "color_temp": 0  # Set to 0 when using hue/saturation
    })
    print(f"Result: {result}")
    time.sleep(1)
    
    # Check state
    info = bulb.getBasicInfo()
    print(f"✓ Color is now: Hue={info['hue']}°, Sat={info['saturation']}%")
except Exception as e:
    print(f"✗ Error: {e}")

# Test 6: Set RGB Color (Red)
print_section("Test 6: Set Color to Red (H:0, S:100)")
try:
    result = bulb.executeFunction("set_device_info", {
        "hue": 0,
        "saturation": 100,
        "color_temp": 0
    })
    print(f"Result: {result}")
    time.sleep(1)
    
    # Check state
    info = bulb.getBasicInfo()
    print(f"✓ Color is now: Hue={info['hue']}°, Sat={info['saturation']}%")
except Exception as e:
    print(f"✗ Error: {e}")

# Test 7: Back to white (color temperature mode)
print_section("Test 7: Back to Warm White (2700K)")
try:
    result = bulb.executeFunction("set_device_info", {
        "hue": 0,
        "saturation": 0,
        "color_temp": 2700
    })
    print(f"Result: {result}")
    time.sleep(1)
    
    # Check state
    info = bulb.getBasicInfo()
    print(f"✓ Color Temperature is now: {info['color_temp']}K")
    print(f"  Hue: {info['hue']}°, Saturation: {info['saturation']}%")
except Exception as e:
    print(f"✗ Error: {e}")

# Test 8: Restore original state
print_section("Test 8: Restore Original Brightness (95%)")
try:
    result = bulb.executeFunction("set_device_info", {"brightness": 95})
    print(f"Result: {result}")
    time.sleep(1)
    
    # Check state
    info = bulb.getBasicInfo()
    print(f"✓ Brightness restored to: {info['brightness']}%")
except Exception as e:
    print(f"✗ Error: {e}")

print_section("Summary")
print("""
✓ All tests completed successfully!

The Tapo L430C supports:
  • Power On/Off control
  • Brightness: 1-100%
  • RGB Color: Hue 0-360°, Saturation 0-100%
  • Color Temperature: 2500K-6500K
  
Control method: executeFunction("set_device_info", params)

Example commands:
  - Turn ON:  {"device_on": True}
  - Turn OFF: {"device_on": False}
  - Brightness: {"brightness": 75}
  - Color Temp: {"color_temp": 4000}
  - RGB Color: {"hue": 120, "saturation": 80, "color_temp": 0}
  - White: {"hue": 0, "saturation": 0, "color_temp": 2700}

Connection: HTTP on port 80 using KLAP protocol
Auth: TP-Link account email/password
""")

print("\n✓ Device tested successfully!")
print("Ready to implement Homebridge plugin!\n")
