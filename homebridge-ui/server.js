/**
 * Custom UI Server for Homebridge Tapo Plugin
 * Handles device discovery requests from the config UI
 */

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { discoverDevices, checkDevice, testConnection, verifyDevices, encryptCredential, decryptCredential, isEncryptionAvailable } = require('../dist/utils');

class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // Handle device discovery requests
    this.onRequest('/discover', async (payload) => {
      try {
        const { email, password } = payload || {};

        if (!email || !password) {
          throw new RequestError('Email and password are required', { status: 400 });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          throw new RequestError('Invalid email format', { status: 400 });
        }

        // Perform device discovery with progress updates
        const credentials = { email, password };
        const devices = await discoverDevices(credentials, {
          info: (msg) => {
            console.log(`[Tapo Discovery] ${msg}`);
            this.pushEvent('discovery_progress', { message: msg });
          },
          warn: (msg) => console.warn(`[Tapo Discovery] ${msg}`),
        }, (status) => {
          this.pushEvent('discovery_progress', { message: status });
        });

        return {
          success: true,
          devices: devices,
        };
      } catch (error) {
        console.error('Discovery error:', error);
        throw error;
      }
    });

    // Handle checking a single device by IP
    this.onRequest('/check-device', async (payload) => {
      try {
        const { email, password, ip, name } = payload || {};

        if (!email || !password) {
          throw new RequestError('Email and password are required', { status: 400 });
        }

        if (!ip) {
          throw new RequestError('IP address is required', { status: 400 });
        }

        // Validate IP format
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (!ipRegex.test(ip)) {
          throw new RequestError('Invalid IP address format', { status: 400 });
        }

        const credentials = { email, password };
        const device = await checkDevice(ip, credentials);

        if (device) {
          // Override name if provided
          if (name) {
            device.name = name;
          }
          return {
            success: true,
            device: device,
          };
        } else {
          // Device not found but user wants to add manually
          return {
            success: true,
            device: {
              name: name || `Tapo Device (${ip})`,
              ip: ip,
              mac: `manual-${ip.replace(/\./g, '-')}`,
              model: 'Unknown',
              type: 'light',
              online: false,
              manual: true,
            },
          };
        }
      } catch (error) {
        console.error('Check device error:', error);
        throw error;
      }
    });

    // Handle testing connection to a device with detailed error feedback
    this.onRequest('/test-connection', async (payload) => {
      try {
        const { ip } = payload || {};
        let { email, password } = payload || {};

        // If credentials not provided, try to use stored credentials
        if (!email || !password) {
          const storedCreds = await this.getStoredCredentials();
          if (storedCreds) {
            email = storedCreds.email;
            password = storedCreds.password;
          } else {
            throw new RequestError('No credentials provided and no stored credentials available', { status: 400 });
          }
        }

        if (!ip) {
          throw new RequestError('IP address is required', { status: 400 });
        }

        // Validate IP format
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (!ipRegex.test(ip)) {
          throw new RequestError('Invalid IP address format', { status: 400 });
        }

        const credentials = { email, password };
        const result = await testConnection(ip, credentials);
        return result;
      } catch (error) {
        console.error('Test connection error:', error);
        throw error;
      }
    });

    // Handle verifying multiple devices at once
    this.onRequest('/verify-devices', async (payload) => {
      try {
        const { devices } = payload || {};
        let { email, password } = payload || {};

        // If credentials not provided, try to use stored credentials
        if (!email || !password) {
          const storedCreds = await this.getStoredCredentials();
          if (storedCreds) {
            email = storedCreds.email;
            password = storedCreds.password;
          } else {
            throw new RequestError('No credentials provided and no stored credentials available', { status: 400 });
          }
        }

        if (!devices || !Array.isArray(devices) || devices.length === 0) {
          throw new RequestError('Devices array is required', { status: 400 });
        }

        const credentials = { email, password };
        const results = await verifyDevices(devices, credentials);
        return {
          success: true,
          results: results,
        };
      } catch (error) {
        console.error('Verify devices error:', error);
        throw error;
      }
    });

    // Handle credential encryption requests
    this.onRequest('/encrypt-credentials', async (payload) => {
      try {
        const { email, password } = payload || {};

        if (!email || !password) {
          throw new RequestError('Email and password are required', { status: 400 });
        }

        const storagePath = this.homebridgeStoragePath;
        if (!isEncryptionAvailable(storagePath)) {
          throw new RequestError('Encryption unavailable - bridge credentials not found', { status: 500 });
        }

        const encryptedEmail = encryptCredential(email, storagePath);
        const encryptedPassword = encryptCredential(password, storagePath);

        if (!encryptedEmail || !encryptedPassword) {
          throw new RequestError('Encryption failed', { status: 500 });
        }

        return {
          email: encryptedEmail,
          password: encryptedPassword,
        };
      } catch (error) {
        console.error('Encryption error:', error);
        throw error;
      }
    });

    // Ready
    this.ready();
  }

  /**
   * Get decrypted credentials from stored plugin config
   * Returns null if no stored credentials are available
   */
  async getStoredCredentials() {
    try {
      const pluginConfig = await this.getPluginConfig();
      if (!pluginConfig || pluginConfig.length === 0) {
        return null;
      }
      
      const config = pluginConfig[0];
      if (!config.email || !config.password) {
        return null;
      }
      
      // If credentials are encrypted, decrypt them
      if (config.isEncrypted) {
        const email = decryptCredential(config.email, this.homebridgeStoragePath);
        const password = decryptCredential(config.password, this.homebridgeStoragePath);
        
        if (!email || !password) {
          console.warn('[Tapo] Failed to decrypt stored credentials');
          return null;
        }
        
        return { email, password };
      }
      
      // Return plaintext credentials
      return { email: config.email, password: config.password };
    } catch (error) {
      console.warn('[Tapo] Error getting stored credentials:', error.message);
      return null;
    }
  }
}

// Start the server
(() => {
  return new PluginUiServer();
})();
