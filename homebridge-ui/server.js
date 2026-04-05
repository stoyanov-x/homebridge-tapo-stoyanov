/**
 * Custom UI Server for Homebridge Tapo Plugin
 * Handles device discovery requests from the config UI
 */

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { discoverDevices, checkDevice, testConnection, verifyDevices, encryptCredential, decryptCredential, isEncryptionAvailable } = require('../dist/utils');
const { SecretRequestClient } = require('../dist/external/secret-client');

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

        if (!ip) {
          throw new RequestError('IP address is required', { status: 400 });
        }

        // Validate IP format
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (!ipRegex.test(ip)) {
          throw new RequestError('Invalid IP address format', { status: 400 });
        }

        // ALWAYS use server-side stored credentials for security
        // Never accept credentials from client to prevent plaintext transmission
        const storedCreds = await this.getStoredCredentials();
        if (!storedCreds) {
          throw new RequestError('No saved configuration found. Please save your configuration first.', { status: 400 });
        }

        const credentials = { email: storedCreds.email, password: storedCreds.password };
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

        if (!devices || !Array.isArray(devices) || devices.length === 0) {
          throw new RequestError('Devices array is required', { status: 400 });
        }

        // ALWAYS use server-side stored credentials for security
        const storedCreds = await this.getStoredCredentials();
        if (!storedCreds) {
          throw new RequestError('No saved configuration found. Please save your configuration first.', { status: 400 });
        }

        const credentials = { email: storedCreds.email, password: storedCreds.password };
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

    // Test Secret Request server connection
    this.onRequest('/test-secret-server', async (payload) => {
      try {
        const { serverUrl, apiKey, secretName, secretTimeout } = payload || {};

        if (!serverUrl) {
          throw new RequestError('Server URL is required', { status: 400 });
        }

        if (!secretName) {
          throw new RequestError('Secret name is required', { status: 400 });
        }

        try {
          new URL(serverUrl);
        } catch {
          throw new RequestError('Invalid server URL format', { status: 400 });
        }

        // Use provided timeout from UI (in seconds), default to 30s if not specified
        const testTimeout = secretTimeout && secretTimeout > 0 ? secretTimeout : 30;

        const results = {
          health: null,
          e2e: null,
        };

        // Create SecretRequestClient instance with E2E enabled
        const client = new SecretRequestClient({
          serverUrl,
          apiKey,
          e2e: true, // Always test with E2E encryption
        });

        // Test 1: Health check (no auth required)
        try {
          const healthy = await client.healthCheck();
          results.health = {
            success: healthy,
            message: healthy ? 'Server is reachable' : 'Server health check failed',
          };
        } catch (error) {
          results.health = {
            success: false,
            message: error.message || 'Connection failed',
          };
        }

        // Test 2: E2E secret request with UI form values - FULL E2E TEST
        try {
          // Create a test secret request
          const requestId = await client.createRequest(secretName, testTimeout);
          
          if (!requestId) {
            results.e2e = {
              success: false,
              message: 'Failed to create secret request',
            };
          } else {
            // Now actually wait for user to approve/reject on iPhone!
            const waitStart = Date.now();
            try {
              const secret = await client.waitForRequest(requestId, testTimeout);
              const waitDuration = ((Date.now() - waitStart) / 1000).toFixed(1);
              
              // Success! Got credentials back
              const hasEmail = typeof secret === 'object' && secret.email;
              const hasPassword = typeof secret === 'object' && secret.password;
              
              results.e2e = {
                success: true,
                message: `E2E test complete - secret received and decrypted successfully (took ${waitDuration}s)`,
                requestId: requestId,
                credentialsReceived: hasEmail && hasPassword,
                secretType: typeof secret === 'object' ? 'multi-part' : 'string',
                duration: waitDuration,
              };
            } catch (waitError) {
              const waitDuration = ((Date.now() - waitStart) / 1000).toFixed(1);
              
              // Handle approval/rejection outcomes
              if (waitError.code === 'denied') {
                results.e2e = {
                  success: false,
                  message: `Secret request was denied on iPhone (after ${waitDuration}s)`,
                  requestId: requestId,
                  outcome: 'denied',
                  duration: waitDuration,
                };
              } else if (waitError.code === 'timeout') {
                results.e2e = {
                  success: false,
                  message: `Request timed out after ${waitDuration}s - no response from iPhone (timeout was ${testTimeout}s)`,
                  requestId: requestId,
                  outcome: 'timeout',
                  duration: waitDuration,
                  errorDetails: waitError.message,
                };
              } else if (waitError.code === 'cancelled') {
                results.e2e = {
                  success: false,
                  message: `Secret request was cancelled (after ${waitDuration}s)`,
                  requestId: requestId,
                  outcome: 'cancelled',
                  duration: waitDuration,
                };
              } else {
                results.e2e = {
                  success: false,
                  message: `E2E wait failed: ${waitError.message} (after ${waitDuration}s)`,
                  requestId: requestId,
                  outcome: 'error',
                  duration: waitDuration,
                  errorDetails: waitError.message,
                  errorCode: waitError.code,
                };
              }
            }
          }
        } catch (error) {
          // Check if it's an auth error
          if (error.response?.status === 401 || error.response?.status === 403) {
            results.e2e = {
              success: false,
              message: 'API key authentication failed - check your API key',
            };
          } else {
            results.e2e = {
              success: false,
              message: `E2E test failed: ${error.message}`,
            };
          }
        }

        // Determine overall success
        const allPassed = results.health?.success && results.e2e?.success;

        return {
          success: allPassed,
          results: results,
        };
      } catch (error) {
        console.error('Test secret server error:', error);
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
      // Read config.json from disk (server-side doesn't have getPluginConfig method)
      const fs = require('fs');
      const configPath = this.homebridgeConfigPath;
      
      if (!configPath) {
        console.log('[Tapo UI] getStoredCredentials: No config path available');
        return null;
      }
      
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const pluginConfig = configData.platforms?.find(p => p.platform === 'TapoStoyanov');
      
      if (!pluginConfig) {
        console.log('[Tapo UI] getStoredCredentials: No TapoStoyanov config found');
        return null;
      }
      
      console.log('[Tapo UI] getStoredCredentials: credentialType =', pluginConfig.credentialType, ', has email:', !!pluginConfig.email, ', has password:', !!pluginConfig.password, ', isEncrypted:', !!pluginConfig.isEncrypted);
      
      // Check credential type - only traditional mode has email/password
      if (pluginConfig.credentialType === 'secret-request') {
        console.log('[Tapo UI] getStoredCredentials: Using Secret Request mode - no stored credentials');
        return null;
      }
      
      if (!pluginConfig.email || !pluginConfig.password) {
        console.log('[Tapo UI] getStoredCredentials: Missing email or password');
        return null;
      }
      
      // If credentials are encrypted, decrypt them
      if (pluginConfig.isEncrypted) {
        const email = decryptCredential(pluginConfig.email, this.homebridgeStoragePath);
        const password = decryptCredential(pluginConfig.password, this.homebridgeStoragePath);
        
        if (!email || !password) {
          console.warn('[Tapo] Failed to decrypt stored credentials');
          return null;
        }
        
        console.log('[Tapo UI] getStoredCredentials: Successfully decrypted credentials');
        return { email, password };
      }
      
      // Return plaintext credentials
      console.log('[Tapo UI] getStoredCredentials: Returning plaintext credentials');
      return { email: pluginConfig.email, password: pluginConfig.password };
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
