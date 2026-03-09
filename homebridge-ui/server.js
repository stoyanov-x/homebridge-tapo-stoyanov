/**
 * Custom UI Server for Homebridge Tapo Plugin
 * Handles device discovery requests from the config UI
 */

const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const { discoverDevices, getDecryptedCredentials, encryptCredential } = require('./dist/utils');

class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // Handle device discovery requests
    this.onRequest('/discover', async (payload) => {
      try {
        const { email, password } = payload;

        if (!email || !password) {
          throw new Error('Email and password are required');
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          throw new Error('Invalid email format');
        }

        this.pushEvent('discovery_started', {});

        // Perform device discovery
        const credentials = { email, password };
        const devices = await discoverDevices(credentials, {
          info: (msg) => console.log(`[Tapo Discovery] ${msg}`),
          debug: (msg) => console.debug(`[Tapo Discovery] ${msg}`),
        });

        this.pushEvent('discovery_complete', { count: devices.length });

        return {
          success: true,
          devices: devices,
        };
      } catch (error) {
        console.error('Discovery error:', error);
        this.pushEvent('discovery_error', { error: error.message });
        throw error;
      }
    });

    // Handle credential encryption requests
    this.onRequest('/encrypt-credentials', async (payload) => {
      try {
        const { email, password } = payload;

        if (!email || !password) {
          throw new Error('Email and password are required');
        }

        return {
          email: encryptCredential(email),
          password: encryptCredential(password),
        };
      } catch (error) {
        console.error('Encryption error:', error);
        throw error;
      }
    });

    // Ready
    this.ready();
  }
}

// Start the server
(() => {
  return new PluginUiServer();
})();
