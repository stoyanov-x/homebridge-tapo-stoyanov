/**
 * Constants for the Tapo Homebridge plugin
 */

// Configuration defaults
export const DEFAULT_POLLING_INTERVAL = 30; // seconds
export const MIN_POLLING_INTERVAL = 10; // seconds
export const MAX_POLLING_INTERVAL = 300; // seconds

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
