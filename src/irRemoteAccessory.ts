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
  IR_CONTROL_KEYS,
  IR_NAV_KEYS,
  IR_BUTTON_KEYS,
} from './constants';
import { decodeBase64Label, smartCaseLabel, isOpaqueKeyName } from './utils';

export class IrRemoteAccessory {
  private readonly thing: TapoThingInfo;
  private readonly client: TapoCloudClient;
  private readonly television: Service;
  private readonly speaker: Service;
  private readonly inputSources: Service[] = [];
  private readonly buttons: Service[] = [];
  private readonly buttonTimers: NodeJS.Timeout[] = [];
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
   * Fetch the remote's key list and build the InputSource + Switch services.
   * Called by the platform once the accessory is registered.
   */
  async initializeDevice(): Promise<void> {
    try {
      const keys = await this.client.listKeys(this.thing);
      this.buildInputSources(keys);
      this.buildButtons(keys);
      // Persist the rebuilt service set (removed + added) to Homebridge storage
      this.platform.api.updatePlatformAccessories([this.accessory]);
      this.log.info(
        `[${this.config.name}] Loaded ${keys.length} IR keys ` +
        `(${this.inputSources.length} inputs, ${this.buttons.length} buttons)`,
      );
    } catch (error) {
      this.log.error(`[${this.config.name}] Failed to load IR keys:`, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Resolve the display label for an IR key:
   *  1. explicit `irLabels` override from config
   *  2. the send-by key name, auto-cased (LINE1 -> Line 1) — the name field is
   *     authoritative; the cloud's display_name is truncated to 4 chars
   *  3. for opaque menu/nav names (e.g. "7zzAj5Sz"), fall back to the decoded
   *     display_name ("Menu", "Up", ...)
   */
  private labelFor(key: TapoIrKey): string {
    const override = this.config.irLabels?.[key.name];
    if (override) {
      return override;
    }
    if (isOpaqueKeyName(key.name)) {
      return smartCaseLabel(decodeBase64Label(key.display_name)) || key.name;
    }
    return smartCaseLabel(key.name);
  }

  /**
   * Create one InputSource per *source* IR key (Line 1, Line 2, Bluetooth, ...).
   * Power, volume, mute and transport keys are NOT inputs — they're handled by
   * the Television/TelevisionSpeaker characteristics (Active, VolumeSelector,
   * Mute) or exposed as Switch buttons. Selecting an input fires its IR command.
   */
  private buildInputSources(keys: TapoIrKey[]): void {
    // Drop any IR services from a previous run (e.g. keys no longer exposed)
    const stale = this.accessory.services.filter((s) => s.subtype && s.subtype.startsWith('ir-'));
    for (const service of stale) {
      this.accessory.removeService(service);
    }
    this.keyById.clear();
    this.inputSources.length = 0;

    // Apply the optional key filter from config, then skip non-input keys
    const filter = this.config.irKeys;
    const selected = filter && filter.length > 0
      ? keys.filter((key) => filter.includes(key.name))
      : keys;

    for (const key of selected) {
      if (this.isNonInputKey(key)) {
        continue;
      }

      const label = this.labelFor(key);
      const subtype = `ir-${key.id}`;

      const input = this.accessory.addService(
        this.platform.Service.InputSource,
        label,
        subtype,
      );

      input.setCharacteristic(this.platform.Characteristic.Identifier, key.id);
      input.setCharacteristic(this.platform.Characteristic.Name, label);
      // ConfiguredName is what iOS displays in the input grid — without it,
      // every input falls back to showing the accessory name.
      input.setCharacteristic(this.platform.Characteristic.ConfiguredName, label);
      input.setCharacteristic(this.platform.Characteristic.InputSourceType, this.inputSourceType(key));
      input.setCharacteristic(this.platform.Characteristic.IsConfigured, 1); // configured
      input.setCharacteristic(this.platform.Characteristic.CurrentVisibilityState, 0); // shown

      this.keyById.set(key.id, key);
      this.inputSources.push(input);
      this.television.addLinkedService(input);
    }
  }

  /**
   * Create momentary Switch "buttons" for transport/utility keys (Mute, Play,
   * Pause, Next, Previous). Tapping one fires the IR command and it snaps back
   * to off. The set of keys is configurable via `irButtons` (default transport set).
   */
  private buildButtons(keys: TapoIrKey[]): void {
    // Buttons are rebuilt together with inputs (same ir-* stale cleanup above)
    this.buttons.length = 0;

    const wanted = this.config.irButtons && this.config.irButtons.length > 0
      ? this.config.irButtons
      : IR_BUTTON_KEYS;

    for (const key of keys) {
      // Only keys the user asked for (or the default transport set)
      if (!wanted.includes(key.name)) {
        continue;
      }
      // POWER is the TV toggle; inputs are already exposed as inputs
      if (key.name === IR_KEY_POWER || this.keyById.has(key.id)) {
        continue;
      }

      const label = this.labelFor(key);
      const button = this.accessory.addService(
        this.platform.Service.Switch,
        label,
        `ir-btn-${key.id}`,
      );

      button.setCharacteristic(this.platform.Characteristic.Name, label);
      button.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.makeButtonHandler(key, button));

      this.buttons.push(button);
    }
  }

  /**
   * Build the On-characteristic handler for a momentary IR button: fire the key
   * when toggled ON, then snap the switch back to OFF.
   */
  private makeButtonHandler(key: TapoIrKey, button: Service) {
    return async (value: CharacteristicValue): Promise<void> => {
      if (!(value as boolean)) {
        return; // only react to ON presses
      }
      const label = this.labelFor(key);
      this.log.info(`[${this.config.name}] Button: ${label}`);
      try {
        await this.fire(key.name);
      } finally {
        // Momentary: return the switch to OFF shortly after firing
        const timer = setTimeout(() => {
          button.updateCharacteristic(this.platform.Characteristic.On, false);
        }, 400);
        this.buttonTimers.push(timer);
      }
    };
  }

  /**
   * Whether an IR key should be exposed as an input source.
   * Excludes POWER (TV on/off), control keys (volume/mute/transport — handled
   * by the speaker controls), and navigation/menu buttons.
   */
  private isNonInputKey(key: TapoIrKey): boolean {
    if (key.name === IR_KEY_POWER) {
      return true;
    }
    if (IR_CONTROL_KEYS.includes(key.name)) {
      return true;
    }
    const display = decodeBase64Label(key.display_name).trim().toUpperCase();
    return IR_NAV_KEYS.includes(display);
  }

  /**
   * Map a known IR key to a HomeKit InputSourceType for nicer display.
   */
  private inputSourceType(key: TapoIrKey): number {
    const label = `${key.name} ${decodeBase64Label(key.display_name)}`.toUpperCase();
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
    // No active input while the TV is off
    if (!on && this.state.activeIdentifier !== 0) {
      this.state.activeIdentifier = 0;
      this.television.updateCharacteristic(this.platform.Characteristic.ActiveIdentifier, 0);
    }
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
    this.log.info(`[${this.config.name}] Select input: ${this.labelFor(key)}`);
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
    // Cancel any pending momentary-button reset timers
    for (const timer of this.buttonTimers) {
      clearTimeout(timer);
    }
    this.buttonTimers.length = 0;
    this.log.info(`[${this.config.name}] Removed`);
  }
}
