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
        const { serverUrl, apiKey } = payload || {};

        if (!serverUrl) {
          throw new RequestError('Server URL is required', { status: 400 });
        }

        // Validate URL format
        let url;
        try {
          url = new URL(serverUrl);
        } catch {
          throw new RequestError('Invalid server URL format', { status: 400 });
        }

        const https = require('https');
        const http = require('http');
        const client = url.protocol === 'https:' ? https : http;

        // Helper to make HTTP request
        const makeRequest = (path, method = 'GET', body = null) => {
          const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: path,
            method: method,
            headers: {},
            timeout: 5000,
          };

          if (apiKey) {
            options.headers['X-API-Key'] = apiKey;
          }

          if (body) {
            const bodyStr = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
          }

          return new Promise((resolve, reject) => {
            const req = client.request(options, (res) => {
              let data = '';

              res.on('data', (chunk) => {
                data += chunk;
              });

              res.on('end', () => {
                let json = null;
                try {
                  json = JSON.parse(data);
                } catch {
                  // Not JSON
                }
                resolve({ status: res.statusCode, data: json || data });
              });
            });

            req.on('error', (error) => {
              reject(error);
            });

            req.on('timeout', () => {
              req.destroy();
              reject(new Error('Request timeout'));
            });

            if (body) {
              req.write(JSON.stringify(body));
            }
            req.end();
          });
        };

        const results = {
          health: null,
          auth: null,
          secretDelivery: null,
        };

        // Test 1: Health endpoint
        try {
          const health = await makeRequest('/health');
          if (health.status === 200) {
            results.health = {
              success: true,
              message: 'Server is reachable',
              version: health.data?.version,
            };
          } else {
            results.health = {
              success: false,
              message: `HTTP ${health.status}`,
            };
          }
        } catch (error) {
          results.health = {
            success: false,
            message: error.message,
          };
        }

        // Test 2: API key authentication (if provided)
        if (apiKey) {
          try {
            // Test with API key
            const withKey = await makeRequest('/health');
            // Test without API key
            const withoutKey = await makeRequest('/health').catch(() => ({ status: 401 }));
            
            if (withKey.status === 200 && withoutKey.status === 401) {
              results.auth = {
                success: true,
                message: 'API key authentication working correctly',
              };
            } else if (withKey.status === 200) {
              results.auth = {
                success: true,
                message: 'API key accepted (server may not require auth)',
                warning: true,
              };
            } else if (withKey.status === 401 || withKey.status === 403) {
              results.auth = {
                success: false,
                message: 'API key rejected - check your API key',
              };
            }
          } catch (error) {
            results.auth = {
              success: false,
              message: `Auth test failed: ${error.message}`,
            };
          }
        }

        // Determine overall success
        const allPassed = results.health?.success && 
                         (results.auth?.success !== false);

        return {
          success: allPassed,
          version: results.health?.version,
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
      const pluginConfig = await this.getPluginConfig();
      
      if (!pluginConfig || pluginConfig.length === 0) {
        console.log('[Tapo UI] getStoredCredentials: No plugin config found');
        return null;
      }
      
      const config = pluginConfig[0];
      console.log('[Tapo UI] getStoredCredentials: credentialType =', config.credentialType, ', has email:', !!config.email, ', has password:', !!config.password, ', isEncrypted:', !!config.isEncrypted);
      
      // Check credential type - only traditional mode has email/password
      if (config.credentialType === 'secret-request') {
        console.log('[Tapo UI] getStoredCredentials: Using Secret Request mode - no stored credentials');
        return null;
      }
      
      if (!config.email || !config.password) {
        console.log('[Tapo UI] getStoredCredentials: Missing email or password');
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
        
        console.log('[Tapo UI] getStoredCredentials: Successfully decrypted credentials');
        return { email, password };
      }
      
      // Return plaintext credentials
      console.log('[Tapo UI] getStoredCredentials: Returning plaintext credentials');
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
