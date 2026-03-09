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
