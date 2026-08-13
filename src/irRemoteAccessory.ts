/**
 * Tapo IR Remote Accessory
 *
 * Represents a Tapo H110 hub's paired IR remote (e.g. an Edifier S2000
 * speaker) in HomeKit as a `Television` with a linked `TelevisionSpeaker`
 * and one `InputSource` per IR key reported by the remote.
 *
 * IR commands are fire-and-forget — the physical device reports no status
 * back — so all state is tracked optimistically. Commands are fired through
 * the Tapo Cloud Thing API (see tapoCloudClient.ts), so no LAN access or
 * device password is needed.
 */

import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  Logger,
} from 'homebridge';

import { TapoPlatform } from './platform';
import { TapoCloudClient } from './tapoCloudClient';
import { TapoDeviceConfig, TapoThingInfo, TapoIrKey } from './types';
import {
  DEVICE_MANUFACTURER,
  IR_DEVICE_MODEL,
  IR_KEY_POWER,
  IR_KEY_MUTE,
  IR_KEY_VOLUME_UP,
  IR_KEY_VOLUME_DOWN,
} from './constants';
import { decodeBase64Label } from './utils';

export class IrRemoteAccessory {
  private readonly thing: TapoThingInfo;
  private readonly client: TapoCloudClient;
  private readonly television: Service;
  private readonly speaker: Service;
  private readonly inputSources: Service[] = [];
  private readonly keyById = new Map<number, TapoIrKey>();

  // Optimistic state (IR is fire-and-forget; we can't query the physical device)
  private state = {
    active: false,
    muted: false,
    volume: 50, // 0-100, tracked optimistically for the Home app volume slider
    activeIdentifier: 0,
  };

  constructor(
    private readonly platform: TapoPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: TapoDeviceConfig,
    thing: TapoThingInfo,
    client: TapoCloudClient,
    private readonly log: Logger,
  ) {
    this.thing = thing;
    this.client = client;

    // ── Accessory information ──────────────────────────────────────────
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, DEVICE_MANUFACTURER)
      .setCharacteristic(this.platform.Characteristic.Model, thing.model || IR_DEVICE_MODEL)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, thing.mac || thing.thingName);

    // ── Television service ─────────────────────────────────────────────
    this.television = this.accessory.getService(this.platform.Service.Television)
      || this.accessory.addService(this.platform.Service.Television);

    this.television.setCharacteristic(this.platform.Characteristic.ConfiguredName, config.name);
    this.television.setCharacteristic(this.platform.Characteristic.SleepDiscoveryMode, 1); // Always discoverable

    // Active = power toggle (fires the POWER IR key on change)
    this.television.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(() => this.state.active);

    // ActiveIdentifier = the currently selected input source (fires its IR key)
    this.television.getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
      .onSet(this.setActiveIdentifier.bind(this))
      .onGet(() => this.state.activeIdentifier);

    // ── TelevisionSpeaker service ──────────────────────────────────────
    this.speaker = this.accessory.getService(this.platform.Service.TelevisionSpeaker)
      || this.accessory.addService(this.platform.Service.TelevisionSpeaker);

    this.speaker.setCharacteristic(this.platform.Characteristic.Name, config.name);
    this.speaker.setCharacteristic(this.platform.Characteristic.VolumeControlType, 1); // Relative

    // VolumeSelector: 0 = increment (VOL+), 1 = decrement (VOL-)
    this.speaker.getCharacteristic(this.platform.Characteristic.VolumeSelector)
      .onSet(this.setVolumeSelector.bind(this));

    // Volume is get-only (no absolute IR volume) — tracks optimistically
    this.speaker.getCharacteristic(this.platform.Characteristic.Volume)
      .onGet(() => this.state.volume);

    // Mute fires the MUTE IR key
    this.speaker.getCharacteristic(this.platform.Characteristic.Mute)
      .onSet(this.setMute.bind(this))
      .onGet(() => this.state.muted);

    // Link the speaker to the television
    this.television.addLinkedService(this.speaker);
  }

  /**
   * Fetch the remote's key list and build the InputSource services.
   * Called by the platform once the accessory is registered.
   */
  async initializeDevice(): Promise<void> {
    try {
      const keys = await this.client.listKeys(this.thing);
      this.buildInputSources(keys);
      this.log.info(`[${this.config.name}] Loaded ${keys.length} IR keys (${this.inputSources.length} exposed)`);
    } catch (error) {
      this.log.error(`[${this.config.name}] Failed to load IR keys:`, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Create one InputSource per IR key (excluding POWER, which maps to Active).
   * Selecting an input in HomeKit fires the corresponding IR command.
   */
  private buildInputSources(keys: TapoIrKey[]): void {
    // Apply the optional key filter from config
    const filter = this.config.irKeys;
    const selected = filter && filter.length > 0
      ? keys.filter((key) => filter.includes(key.name))
      : keys;

    for (const key of selected) {
      // POWER is the TV on/off toggle — not an input source
      if (key.name === IR_KEY_POWER) {
        continue;
      }

      const label = decodeBase64Label(key.display_name) || key.name;
      const subtype = `ir-${key.id}`;

      const input = this.accessory.addService(
        this.platform.Service.InputSource,
        label,
        subtype,
      );

      input.setCharacteristic(this.platform.Characteristic.Identifier, key.id);
      input.setCharacteristic(this.platform.Characteristic.Name, label);
      input.setCharacteristic(this.platform.Characteristic.InputSourceType, this.inputSourceType(key));
      input.setCharacteristic(this.platform.Characteristic.IsConfigured, 1); // configured
      input.setCharacteristic(this.platform.Characteristic.CurrentVisibilityState, 0); // shown

      this.keyById.set(key.id, key);
      this.inputSources.push(input);
      this.television.addLinkedService(input);
    }
  }

  /**
   * Map a known IR key to a HomeKit InputSourceType for nicer display.
   */
  private inputSourceType(key: TapoIrKey): number {
    const label = `${decodeBase64Label(key.display_name)} ${key.name}`.toUpperCase();
    if (label.includes('BLUETOOTH')) {
      return 11; // Bluetooth
    }
    if (label.includes('HDMI')) {
      return 3; // HDMI
    }
    if (label.includes('USB')) {
      return 9; // USB
    }
    return 0; // Other
  }

  // ── Characteristic handlers ───────────────────────────────────────────

  /**
   * Television power. Fires the POWER IR key only when the requested state
   * changes (avoids re-toggling on HomeKit cache restores).
   */
  async setActive(value: CharacteristicValue) {
    const on = value as boolean;
    if (on === this.state.active) {
      return;
    }
    this.state.active = on;
    this.log.info(`[${this.config.name}] Power ${on ? 'ON' : 'OFF'}`);
    await this.fire(IR_KEY_POWER);
  }

  /**
   * An input source was selected in HomeKit — fire its IR key.
   */
  async setActiveIdentifier(value: CharacteristicValue) {
    const id = value as number;
    if (id === this.state.activeIdentifier) {
      return;
    }
    this.state.activeIdentifier = id;

    const key = this.keyById.get(id);
    if (!key) {
      return;
    }
    const label = decodeBase64Label(key.display_name) || key.name;
    this.log.info(`[${this.config.name}] Select input: ${label}`);
    await this.fire(key.name);
  }

  /**
   * Volume selector from the Home app volume control.
   * 0 = increment (VOL+), 1 = decrement (VOL-).
   */
  async setVolumeSelector(value: CharacteristicValue) {
    const selector = value as number;
    if (selector === 0) {
      this.state.volume = Math.min(100, this.state.volume + 1);
      await this.fire(IR_KEY_VOLUME_UP);
    } else if (selector === 1) {
      this.state.volume = Math.max(0, this.state.volume - 1);
      await this.fire(IR_KEY_VOLUME_DOWN);
    } else {
      return;
    }

    // Keep the Home app's volume slider in sync (optimistically)
    this.speaker.updateCharacteristic(this.platform.Characteristic.Volume, this.state.volume);
  }

  /**
   * Mute toggle. Fires the MUTE IR key only when the state changes.
   */
  async setMute(value: CharacteristicValue) {
    const muted = value as boolean;
    if (muted === this.state.muted) {
      return;
    }
    this.state.muted = muted;
    this.log.info(`[${this.config.name}] ${muted ? 'Muted' : 'Unmuted'}`);
    await this.fire(IR_KEY_MUTE);
  }

  /**
   * Fire an IR command through the cloud. Throws a HomeKit communication
   * error so the accessory shows as unavailable if the cloud call fails.
   */
  private async fire(keyName: string): Promise<void> {
    try {
      await this.client.fireKey(this.thing, keyName);
    } catch (error) {
      this.log.error(`[${this.config.name}] Fire "${keyName}" failed:`, error instanceof Error ? error.message : String(error));
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Cleanup when the accessory is removed.
   */
  destroy() {
    this.log.info(`[${this.config.name}] Removed`);
  }
}
