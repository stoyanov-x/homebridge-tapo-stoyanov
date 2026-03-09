/**
 * Utilities for credential encryption and device discovery
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TapoClient } from './tapoClient';
import { TapoCredentials, DiscoveredDevice } from './types';
import {
  ENCRYPTION_ALGORITHM,
  ENCRYPTION_KEY_LENGTH,
  ENCRYPTION_IV_LENGTH,
  PBKDF2_ITERATIONS,
  PBKDF2_DIGEST,
  DERIVATION_SALT,
  DEFAULT_FALLBACK_SUBNETS,
  NETWORK_SCAN_RANGE,
  NETWORK_SCAN_BATCH_SIZE,
  DEVICE_SCAN_TIMEOUT,
  DEVICE_CHECK_TIMEOUT,
} from './constants';

/**
 * Normalize device type from cloud API to internal type
 * Maps SMART.TAPOBULB, SMART.TAPOPLUG, etc. to 'light', 'plug', etc.
 * Returns the original type if not recognized (will trigger unsupported warning)
 */
export function normalizeDeviceType(cloudType: string | undefined): string {
  if (!cloudType) {
    return 'unknown';
  }
  
  const typeUpper = cloudType.toUpperCase();
  
  // Map cloud API types to internal types
  if (typeUpper.includes('BULB') || typeUpper.includes('LIGHT')) {
    return 'light';
  }
  if (typeUpper.includes('PLUG') || typeUpper.includes('SOCKET')) {
    return 'plug';
  }
  if (typeUpper.includes('STRIP')) {
    return 'strip';
  }
  if (typeUpper.includes('SWITCH')) {
    return 'switch';
  }
  
  // Return original type for unrecognized devices - will trigger warning in platform
  return cloudType;
}

/**
 * Read Homebridge bridge credentials from config.json
 * These are used to derive a unique encryption key per installation
 */
function getBridgeCredentials(storagePath: string): { username: string; pin: string } | null {
  try {
    const configPath = path.join(storagePath, 'config.json');
    if (!fs.existsSync(configPath)) {
      return null;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const bridge = config?.bridge;

    if (!bridge?.username || !bridge?.pin) {
      return null;
    }

    return {
      username: bridge.username,
      pin: bridge.pin,
    };
  } catch {
    return null;
  }
}

/**
 * Derive encryption key from bridge credentials using PBKDF2
 */
function deriveKey(credentials: { username: string; pin: string }): Buffer {
  const password = `${credentials.username}:${credentials.pin}`;
  return crypto.pbkdf2Sync(
    password,
    DERIVATION_SALT,
    PBKDF2_ITERATIONS,
    ENCRYPTION_KEY_LENGTH,
    PBKDF2_DIGEST,
  );
}

/**
 * Encrypt a credential string
 * Returns null if encryption is unavailable (bridge credentials not found)
 */
export function encryptCredential(value: string, storagePath: string): string | null {
  const credentials = getBridgeCredentials(storagePath);
  if (!credentials) {
    return null;
  }

  const key = deriveKey(credentials);
  const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  
  let encrypted = cipher.update(value, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  
  const authTag = cipher.getAuthTag();
  
  // Combine IV, auth tag, and encrypted data (base64 for cleaner storage)
  const combined = iv.toString('base64') + ':' + authTag.toString('base64') + ':' + encrypted.toString('base64');
  return 'encrypted:' + combined;
}

/**
 * Decrypt a credential string
 * Returns null if decryption fails
 */
export function decryptCredential(encryptedValue: string, storagePath: string): string | null {
  if (!encryptedValue.startsWith('encrypted:')) {
    // Not encrypted, return as-is
    return encryptedValue;
  }

  const credentials = getBridgeCredentials(storagePath);
  if (!credentials) {
    return null;
  }

  try {
    const value = encryptedValue.substring('encrypted:'.length);
    const parts = value.split(':');
    
    if (parts.length !== 3) {
      return null;
    }

    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const encrypted = Buffer.from(parts[2], 'base64');

    const key = deriveKey(credentials);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Check if encryption is available (bridge credentials exist)
 */
export function isEncryptionAvailable(storagePath: string): boolean {
  return getBridgeCredentials(storagePath) !== null;
}

/**
 * Try to base64-decode a string.
 * Returns the decoded string if it's valid base64 and decodes to readable UTF-8,
 * otherwise returns the original string.
 */
export function tryBase64Decode(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  try {
    // Check if it looks like base64 (only alphanumeric, +, /, =)
    if (!/^[A-Za-z0-9+/]+=*$/.test(value)) {
      return value;
    }

    const decoded = Buffer.from(value, 'base64').toString('utf8');
    
    // Verify the decoded string is valid UTF-8 with printable characters
    // If it contains mostly control characters or invalid UTF-8, it's probably not base64-encoded text
    const printableRatio = decoded.replace(/[\x00-\x1F\x7F-\x9F]/g, '').length / decoded.length;
    if (printableRatio < 0.9) {
      return value;
    }

    // Re-encode to verify it was actually base64
    const reencoded = Buffer.from(decoded, 'utf8').toString('base64');
    // Remove padding differences
    const normalizedOriginal = value.replace(/=+$/, '');
    const normalizedReencoded = reencoded.replace(/=+$/, '');
    
    if (normalizedOriginal === normalizedReencoded) {
      return decoded;
    }
  } catch {
    // Not valid base64, return original
  }

  return value;
}

/**
 * Get decrypted credentials from config
 */
export function getDecryptedCredentials(
  config: { email: string; password: string; isEncrypted?: boolean },
  storagePath: string,
): TapoCredentials {
  if (config.isEncrypted) {
    const email = decryptCredential(config.email, storagePath);
    const password = decryptCredential(config.password, storagePath);
    
    if (!email || !password) {
      throw new Error('Failed to decrypt credentials - bridge credentials may have changed');
    }
    
    return { email, password };
  }
  return {
    email: config.email,
    password: config.password,
  };
}

/**
 * Get local subnet(s) to scan
 */
function getLocalSubnets(): string[] {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const subnets: string[] = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      // Skip non-IPv4, internal, and loopback
      if (iface.family !== 'IPv4' || iface.internal) {
        continue;
      }
      
      // Extract subnet from IP (e.g., 192.168.1.100 -> 192.168.1)
      const parts = iface.address.split('.');
      if (parts.length === 4) {
        const subnet = parts.slice(0, 3).join('.');
        if (!subnets.includes(subnet)) {
          subnets.push(subnet);
        }
      }
    }
  }

  // Fallback to common subnets if none found
  if (subnets.length === 0) {
    subnets.push(...DEFAULT_FALLBACK_SUBNETS);
  }

  return subnets;
}

/**
 * Discover Tapo devices on the network
 * Auto-detects local subnet(s) and scans for devices
 */
export async function discoverDevices(credentials: TapoCredentials, logger?: any, progressCallback?: (status: string) => void): Promise<DiscoveredDevice[]> {
  const devices: DiscoveredDevice[] = [];
  
  const subnets = getLocalSubnets();
  const scanRange = NETWORK_SCAN_RANGE;
  
  const log = logger || console;
  log.info?.(`Detected subnets: ${subnets.join(', ')}`);
  progressCallback?.(`Scanning ${subnets.length} subnet(s): ${subnets.join(', ')}`);

  for (const subnet of subnets) {
    log.info?.(`Scanning network ${subnet}.0/24 for Tapo devices...`);
    progressCallback?.(`Scanning ${subnet}.0/24...`);

    // Scan in batches to avoid overwhelming the network
    const batchSize = NETWORK_SCAN_BATCH_SIZE;
    const promises: Promise<void>[] = [];

    for (let i = 1; i <= scanRange; i++) {
      const ip = `${subnet}.${i}`;
      
      const scanPromise = (async () => {
        try {
          const client = new TapoClient(ip, credentials);
          const info = await Promise.race([
            client.getDeviceInfo(),
            new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error('timeout')), DEVICE_SCAN_TIMEOUT)
            ),
          ]);

          if (info) {
            const decodedNickname = tryBase64Decode(info.nickname);
            devices.push({
              name: decodedNickname || info.model,
              nickname: decodedNickname,
              ip: ip,
              mac: info.mac || `unknown-${ip}`,
              model: info.model || 'Unknown',
              type: normalizeDeviceType(info.type),
              online: true,
              device_on: info.device_on,
              hw_ver: info.hw_ver,
              fw_ver: info.fw_ver,
            });
            log.info?.(`Found device: ${decodedNickname || info.model} at ${ip}`);
            progressCallback?.(`Found: ${decodedNickname || info.model} at ${ip}`);
          }
        } catch (error) {
          // Device not found or not responding - this is expected for most IPs
        }
      })();

      promises.push(scanPromise);

      // Wait for batch to complete before starting next batch
      if (promises.length >= batchSize) {
        await Promise.all(promises);
        promises.length = 0;
        // Progress update every batch
        const progress = Math.round((i / scanRange) * 100);
        progressCallback?.(`Scanning ${subnet}.x... ${progress}% (${devices.length} found)`);
      }
    }

    // Wait for remaining promises
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  log.info?.(`Discovery complete. Found ${devices.length} device(s)`);
  progressCallback?.(`Discovery complete. Found ${devices.length} device(s)`);
  return devices;
}

/**
 * Quick check if a specific IP has a Tapo device
 */
export async function checkDevice(ip: string, credentials: TapoCredentials): Promise<DiscoveredDevice | null> {
  try {
    const client = new TapoClient(ip, credentials);
    const info = await Promise.race([
      client.getDeviceInfo(),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('timeout')), DEVICE_CHECK_TIMEOUT)
      ),
    ]);

    if (info) {
      const decodedNickname = tryBase64Decode(info.nickname);
      return {
        name: decodedNickname || info.model,
        nickname: decodedNickname,
        ip: ip,
        mac: info.mac || `unknown-${ip}`,
        model: info.model || 'Unknown',
        type: normalizeDeviceType(info.type),
        online: true,
        device_on: info.device_on,
        hw_ver: info.hw_ver,
        fw_ver: info.fw_ver,
      };
    }
  } catch (error) {
    // Device not responding
  }
  
  return null;
}

/**
 * Connection test result
 */
export interface ConnectionTestResult {
  success: boolean;
  status: 'connected' | 'auth_failed' | 'timeout' | 'unreachable' | 'error';
  message: string;
  device?: DiscoveredDevice;
}

/**
 * Test connection to a specific device with detailed error reporting
 */
export async function testConnection(ip: string, credentials: TapoCredentials): Promise<ConnectionTestResult> {
  try {
    const client = new TapoClient(ip, credentials);
    const info = await Promise.race([
      client.getDeviceInfo(),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('timeout')), DEVICE_CHECK_TIMEOUT)
      ),
    ]);

    if (info) {
      const decodedNickname = tryBase64Decode(info.nickname);
      return {
        success: true,
        status: 'connected',
        message: `Connected to ${decodedNickname || info.model}`,
        device: {
          name: decodedNickname || info.model,
          nickname: decodedNickname,
          ip: ip,
          mac: info.mac || `unknown-${ip}`,
          model: info.model || 'Unknown',
          type: normalizeDeviceType(info.type),
          online: true,
          device_on: info.device_on,
          hw_ver: info.hw_ver,
          fw_ver: info.fw_ver,
        },
      };
    }

    return {
      success: false,
      status: 'error',
      message: 'Device responded but returned no data',
    };
  } catch (error: any) {
    const errorMessage = error?.message?.toLowerCase() || '';
    
    // Check for authentication errors
    if (errorMessage.includes('auth') || 
        errorMessage.includes('401') || 
        errorMessage.includes('403') ||
        errorMessage.includes('credential') ||
        errorMessage.includes('hash verification failed') ||
        errorMessage.includes('invalid credentials')) {
      return {
        success: false,
        status: 'auth_failed',
        message: 'Authentication failed - check your TP-Link email and password',
      };
    }
    
    // Check for status 400 (usually auth related in KLAP)
    if (errorMessage.includes('400') || errorMessage.includes('handshake')) {
      return {
        success: false,
        status: 'auth_failed',
        message: 'Authentication failed - invalid credentials or unsupported device',
      };
    }
    
    // Check for timeout
    if (errorMessage.includes('timeout')) {
      return {
        success: false,
        status: 'timeout',
        message: 'Connection timed out - device may be offline or IP is incorrect',
      };
    }
    
    // Check for network errors
    if (errorMessage.includes('econnrefused') || 
        errorMessage.includes('ehostunreach') ||
        errorMessage.includes('enetunreach') ||
        errorMessage.includes('enotfound')) {
      return {
        success: false,
        status: 'unreachable',
        message: 'Device unreachable - check IP address and network connection',
      };
    }
    
    // Generic error
    return {
      success: false,
      status: 'error',
      message: `Connection error: ${error?.message || 'Unknown error'}`,
    };
  }
}

/**
 * Verify multiple devices and return their connection status
 */
export async function verifyDevices(
  devices: Array<{ ip: string; name: string; mac: string }>,
  credentials: TapoCredentials
): Promise<Array<{ ip: string; name: string; mac: string; result: ConnectionTestResult }>> {
  const results: Array<{ ip: string; name: string; mac: string; result: ConnectionTestResult }> = [];
  
  // Test devices in parallel with limited concurrency
  const batchSize = 5;
  for (let i = 0; i < devices.length; i += batchSize) {
    const batch = devices.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (device) => {
        const result = await testConnection(device.ip, credentials);
        return { ...device, result };
      })
    );
    results.push(...batchResults);
  }
  
  return results;
}
