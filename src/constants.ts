/**
 * Constants for the Tapo Homebridge plugin
 */

// Configuration defaults
export const DEFAULT_POLLING_INTERVAL = 30; // seconds

// Device information defaults
export const DEVICE_MANUFACTURER = 'TP-Link';
export const DEVICE_MODEL = 'L430C';
export const DEFAULT_COLOR_TEMP_RANGE: [number, number] = [2500, 6500]; // Kelvin

// State defaults
export const DEFAULT_BRIGHTNESS = 100; // percent
export const DEFAULT_COLOR_TEMP_MIRED = 140; // Mired (1,000,000/Kelvin)
export const DEFAULT_HUE = 0; // degrees
export const DEFAULT_SATURATION = 0; // percent

// Timing constants
export const COLOR_UPDATE_BATCH_DELAY = 100; // milliseconds

// Encryption constants (key derived from bridge credentials)
export const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
export const ENCRYPTION_KEY_LENGTH = 32; // 256 bits
export const ENCRYPTION_IV_LENGTH = 16; // 128 bits for GCM
export const PBKDF2_ITERATIONS = 100000;
export const PBKDF2_DIGEST = 'sha256';
export const DERIVATION_SALT = 'tapo-stoyanov-homebridge-v1';

// Network discovery constants
export const DEFAULT_FALLBACK_SUBNETS = ['192.168.1', '192.168.0', '10.0.0'];
export const NETWORK_SCAN_RANGE = 254; // .1 to .254
export const NETWORK_SCAN_BATCH_SIZE = 20;
export const DEVICE_SCAN_TIMEOUT = 2000; // milliseconds
export const DEVICE_CHECK_TIMEOUT = 3000; // milliseconds

// ── Cloud Thing API (v2) constants ─────────────────────────────────────
// These are the production access key / secret extracted from the Tapo APK
// (r40/C67539a.java). They are NOT user secrets — they are the app's public
// signing credentials, and are what let the plugin authenticate with the
// TP-Link cloud using only the user's account email/password.
export const CLOUD_LOGIN_URL = 'https://eu-wap.tplinkcloud.com';
export const CLOUD_ACCESS_KEY = '4d11b6b9d5ea4d19a829adbb9714b057';
export const CLOUD_SECRET = '6ed7d97f3e73467f8a5bab90b577ba4c';
export const CLOUD_APP_NAME = 'Tapo_Android';
export const CLOUD_APP_VERSION = '3.19.607';
export const CLOUD_APP_OSPF = 'Android';
export const CLOUD_APP_BRAND = 'TPLINK';
export const CLOUD_SERVICE_IDS = [
  'nbu.iot-app-server.app-v2',
  'nbu.iot-cloud-gateway.app-v2',
  'nbu.iot-security.appdevice-v2',
];
export const CLOUD_REQUEST_TIMEOUT = 20000; // milliseconds

// ── IR remote (H110 hub) defaults ──────────────────────────────────────
export const IR_DEVICE_MODEL = 'H110'; // hub model, used when the remote has no model
export const IR_KEY_POWER = 'POWER';
export const IR_KEY_MUTE = 'MUTE';
export const IR_KEY_VOLUME_UP = 'VOL+';
export const IR_KEY_VOLUME_DOWN = 'VOL-';

/**
 * IR keys that are NOT input sources — they map to TV/speaker controls
 * (power → Active, volume → VolumeSelector, mute → Mute) or are transport
 * buttons with no HomeKit home on the Television grid. Never exposed as inputs.
 */
export const IR_CONTROL_KEYS = [
  IR_KEY_VOLUME_UP,
  IR_KEY_VOLUME_DOWN,
  IR_KEY_MUTE,
  'PLAY',
  'PAUSE',
  'PREVIOUS',
  'NEXT',
];

/**
 * IR keys exposed as HomeKit Switch "buttons" (tap to fire).
 *
 * Disabled by default. Adding Switch services to the same accessory causes
 * iOS/Home to fall back to a generic multi-tile layout, which hides the native
 * Television input picker and speaker controls. Users can still opt in via the
 * `irButtons` config option if they prefer explicit tappable tiles.
 */
export const IR_BUTTON_KEYS: string[] = [];

/**
 * IR keys whose decoded display name marks them as navigation/menu buttons
 * (not inputs). Matched case-insensitively against the decoded display name.
 */
export const IR_NAV_KEYS = ['MENU', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'OK', '']; 
