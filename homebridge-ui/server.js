/**
 * Custom UI Server for Homebridge Tapo Plugin
 * Handles device discovery requests from the config UI
 */

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { discoverDevices, checkDevice, encryptCredential } = require('../dist/utils');

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
          debug: (msg) => console.debug(`[Tapo Discovery] ${msg}`),
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

    // Handle credential encryption requests
    this.onRequest('/encrypt-credentials', async (payload) => {
      try {
        const { email, password } = payload || {};

        if (!email || !password) {
          throw new RequestError('Email and password are required', { status: 400 });
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
