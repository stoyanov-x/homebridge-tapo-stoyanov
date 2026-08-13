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
  private static readonly DISPLAY_ORDER_ELEMENT_START = 0x01;
  private static readonly DISPLAY_ORDER_ELEMENT_END = 0x00;
  private static readonly MEDIA_STATE_PLAY = 0;
  private static readonly MEDIA_STATE_PAUSE = 1;
  private static readonly MEDIA_STATE_STOP = 2;

  private readonly thing: TapoThingInfo;
  private readonly client: TapoCloudClient;
  private readonly television: Service;
  private readonly speaker: Service;
  private readonly inputSources: Service[] = [];
  private readonly buttons: Service[] = [];
  private readonly buttonTimers: NodeJS.Timeout[] = [];
  private readonly keyById = new Map<number, TapoIrKey>();
  private readonly keyByName = new Map<string, TapoIrKey>();
  private readonly keyByDisplay = new Map<string, TapoIrKey>();

  // Optimistic state (IR is fire-and-forget; we can't query the physical device)
  private state = {
    active: false,
    muted: false,
    volume: 50, // 0-100, tracked optimistically for the Home app volume slider
    activeIdentifier: 0,
    mediaState: IrRemoteAccessory.MEDIA_STATE_PAUSE,
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

    // RemoteKey powers the Home app / Control Center Remote UI (arrows,
    // select, back, previous/next, play/pause).
    this.television.getCharacteristic(this.platform.Characteristic.RemoteKey)
      .onSet(this.setRemoteKey.bind(this));

    // Media state is optional on TVs, but helps the Apple Remote surface the
    // play/pause transport in a more TV-native way.
    this.television.getCharacteristic(this.platform.Characteristic.CurrentMediaState)
      .onGet(() => this.state.mediaState);
    this.television.getCharacteristic(this.platform.Characteristic.TargetMediaState)
      .onSet(this.setTargetMediaState.bind(this))
      .onGet(() => this.state.mediaState);

    // ── TelevisionSpeaker service ──────────────────────────────────────
    this.speaker = this.accessory.getService(this.platform.Service.TelevisionSpeaker)
      || this.accessory.addService(this.platform.Service.TelevisionSpeaker);

    this.speaker.setCharacteristic(this.platform.Characteristic.Name, config.name);
    // Explicitly mark the speaker as active and advertise that we support
    // relative volume *with* a current volume value. Some Home clients render
    // better speaker controls when both are present.
    this.speaker.setCharacteristic(this.platform.Characteristic.Active, 1);
    this.speaker.setCharacteristic(this.platform.Characteristic.VolumeControlType, 2); // Relative with current

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
      this.cacheKeys(keys);
      this.buildInputSources(keys);
      this.updateDisplayOrder();
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
   * Cache the remote's full key map by both send-by name and decoded display
   * label so RemoteKey handlers can resolve navigation/menu keys.
   */
  private cacheKeys(keys: TapoIrKey[]): void {
    this.keyByName.clear();
    this.keyByDisplay.clear();

    for (const key of keys) {
      this.keyByName.set(key.name, key);
      const display = decodeBase64Label(key.display_name).trim().toUpperCase();
      if (display && !this.keyByDisplay.has(display)) {
        this.keyByDisplay.set(display, key);
      }
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

    // Apply the optional key filter from config, preserving the user's order.
    // When omitted, keep the remote's natural order.
    const filter = this.config.irKeys;
    const selected = filter && filter.length > 0
      ? filter
        .map((name) => keys.find((key) => key.name === name))
        .filter((key): key is TapoIrKey => !!key)
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
   * Set the Television DisplayOrder TLV8 so HomeKit renders inputs in the same
   * order as `this.inputSources` (which already follows `irKeys` when provided).
   */
  private updateDisplayOrder(): void {
    if (this.inputSources.length === 0) {
      return;
    }

    const tlv = this.buildDisplayOrderTLV().toString('base64');
    this.television.setCharacteristic(this.platform.Characteristic.DisplayOrder, tlv);
  }

  /**
   * Encode DisplayOrder as TLV8: each input identifier is a 4-byte little-
   * endian integer with type 0x01, delimited by 0x00/0x00 between elements.
   * This matches known-good HomeKit Television implementations.
   */
  private buildDisplayOrderTLV(): Buffer {
    const parts: Buffer[] = [];

    for (let index = 0; index < this.inputSources.length; index++) {
      if (index > 0) {
        parts.push(Buffer.from([
          IrRemoteAccessory.DISPLAY_ORDER_ELEMENT_END,
          0x00,
        ]));
      }

      const identifier = this.inputSources[index]
        .getCharacteristic(this.platform.Characteristic.Identifier)
        .value as number;
      const idBuffer = Buffer.alloc(4);
      idBuffer.writeUInt32LE(identifier, 0);
      parts.push(Buffer.from([
        IrRemoteAccessory.DISPLAY_ORDER_ELEMENT_START,
        0x04,
        ...idBuffer,
      ]));
    }

    return Buffer.concat(parts);
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

    const selected = wanted
      .map((name) => keys.find((key) => key.name === name))
      .filter((key): key is TapoIrKey => !!key);

    for (const key of selected) {
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

  /**
   * Resolve an IR key by its send-by name or its decoded display label.
   */
  private findKey(name?: string, display?: string): TapoIrKey | undefined {
    if (name) {
      const key = this.keyByName.get(name);
      if (key) {
        return key;
      }
    }
    if (display) {
      return this.keyByDisplay.get(display.toUpperCase());
    }
    return undefined;
  }

  /**
   * Fire a resolved key object and log it by friendly label.
   */
  private async fireKey(key: TapoIrKey | undefined, context: string): Promise<void> {
    if (!key) {
      this.log.debug(`[${this.config.name}] No IR key mapped for ${context}`);
      return;
    }
    this.log.info(`[${this.config.name}] ${context}: ${this.labelFor(key)}`);
    await this.fire(key.name);
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
    this.speaker.updateCharacteristic(this.platform.Characteristic.Active, on ? 1 : 0);
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
   * Handle remote-control buttons from the Apple TV Remote / Home TV remote UI.
   */
  async setRemoteKey(value: CharacteristicValue) {
    const remoteKey = value as number;

    switch (remoteKey) {
      case 2: // NEXT_TRACK
        await this.fireKey(this.findKey('NEXT'), 'Remote next');
        return;
      case 3: // PREVIOUS_TRACK
        await this.fireKey(this.findKey('PREVIOUS'), 'Remote previous');
        return;
      case 4: // ARROW_UP
        await this.fireKey(this.findKey(undefined, 'UP'), 'Remote up');
        return;
      case 5: // ARROW_DOWN
        await this.fireKey(this.findKey(undefined, 'DOWN'), 'Remote down');
        return;
      case 6: // ARROW_LEFT
        await this.fireKey(this.findKey('PREVIOUS'), 'Remote left');
        return;
      case 7: // ARROW_RIGHT
        await this.fireKey(this.findKey('NEXT'), 'Remote right');
        return;
      case 8: // SELECT
        await this.fireKey(this.findKey('PLAY'), 'Remote select');
        return;
      case 9: // BACK
      case 10: // EXIT
        await this.fireKey(this.findKey(undefined, 'MENU'), 'Remote menu');
        return;
      case 11: // PLAY_PAUSE
        await this.togglePlayPause('Remote play/pause');
        return;
      default:
        this.log.debug(`[${this.config.name}] Unhandled RemoteKey: ${remoteKey}`);
    }
  }

  /**
   * Handle the optional TargetMediaState characteristic (play/pause/stop).
   */
  async setTargetMediaState(value: CharacteristicValue) {
    const target = value as number;

    switch (target) {
      case IrRemoteAccessory.MEDIA_STATE_PLAY:
        await this.play('Target media play');
        return;
      case IrRemoteAccessory.MEDIA_STATE_PAUSE:
      case IrRemoteAccessory.MEDIA_STATE_STOP:
        await this.pause('Target media pause');
        return;
      default:
        this.log.debug(`[${this.config.name}] Unhandled TargetMediaState: ${target}`);
    }
  }

  /**
   * Toggle between PLAY and PAUSE based on the last media state we emitted.
   */
  private async togglePlayPause(context: string): Promise<void> {
    if (this.state.mediaState === IrRemoteAccessory.MEDIA_STATE_PLAY) {
      await this.pause(context);
    } else {
      await this.play(context);
    }
  }

  private async play(context: string): Promise<void> {
    const key = this.findKey('PLAY') || this.findKey('PAUSE');
    await this.fireKey(key, context);
    this.state.mediaState = IrRemoteAccessory.MEDIA_STATE_PLAY;
    this.television.updateCharacteristic(this.platform.Characteristic.CurrentMediaState, this.state.mediaState);
    this.television.updateCharacteristic(this.platform.Characteristic.TargetMediaState, this.state.mediaState);
  }

  private async pause(context: string): Promise<void> {
    const key = this.findKey('PAUSE') || this.findKey('PLAY');
    await this.fireKey(key, context);
    this.state.mediaState = IrRemoteAccessory.MEDIA_STATE_PAUSE;
    this.television.updateCharacteristic(this.platform.Characteristic.CurrentMediaState, this.state.mediaState);
    this.television.updateCharacteristic(this.platform.Characteristic.TargetMediaState, this.state.mediaState);
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
