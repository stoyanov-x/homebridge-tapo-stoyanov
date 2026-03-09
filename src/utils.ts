/**
 * Utilities for credential encryption and device discovery
 */

import * as crypto from 'crypto';
import { TapoClient } from './tapoClient';
import { TapoCredentials, DiscoveredDevice } from './types';
import {
  ENCRYPTION_ALGORITHM,
  ENCRYPTION_KEY,
  DEFAULT_FALLBACK_SUBNETS,
  NETWORK_SCAN_RANGE,
  NETWORK_SCAN_BATCH_SIZE,
  DEVICE_SCAN_TIMEOUT,
  DEVICE_CHECK_TIMEOUT,
} from './constants';

/**
 * Encrypt a credential string
 */
export function encryptCredential(value: string): string {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  
  let encrypted = cipher.update(value, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Combine IV, auth tag, and encrypted data
  const combined = iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
  return 'encrypted:' + combined;
}

/**
 * Decrypt a credential string
 */
export function decryptCredential(encryptedValue: string): string {
  if (!encryptedValue.startsWith('encrypted:')) {
    // Not encrypted, return as-is (backward compatibility, though not needed per requirements)
    return encryptedValue;
  }

  const value = encryptedValue.substring('encrypted:'.length);
  const parts = value.split(':');
  
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted credential format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Get decrypted credentials from config
 */
export function getDecryptedCredentials(config: { email: string; password: string; isEncrypted?: boolean }): TapoCredentials {
  if (config.isEncrypted) {
    return {
      email: decryptCredential(config.email),
      password: decryptCredential(config.password),
    };
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
            devices.push({
              name: info.nickname || info.model,
              nickname: info.nickname,
              ip: ip,
              mac: info.mac || `unknown-${ip}`,
              model: info.model || 'Unknown',
              type: info.type || 'light',
              online: true,
              device_on: info.device_on,
              hw_ver: info.hw_ver,
              fw_ver: info.fw_ver,
            });
            log.info?.(`Found device: ${info.nickname || info.model} at ${ip}`);
            progressCallback?.(`Found: ${info.nickname || info.model} at ${ip}`);
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
      return {
        name: info.nickname || info.model,
        nickname: info.nickname,
        ip: ip,
        mac: info.mac || `unknown-${ip}`,
        model: info.model || 'Unknown',
        type: info.type || 'light',
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
