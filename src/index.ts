/**
 * Main entry point for the Tapo Homebridge plugin
 */

import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { TapoPlatform } from './platform';

/**
 * This method registers the platform with Homebridge
 */
export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, TapoPlatform);
};
