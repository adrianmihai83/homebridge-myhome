import type { Characteristic, CharacteristicValue, Logging, PlatformAccessory, Service } from "homebridge";
import type { OwnClient } from "./OwnNet";
import { OwnProtcol } from "./OwnProtcol";

export interface OwnPlatformLike {
  log: Logging;
  controller: OwnClient;
  Service: typeof Service;
  Characteristic: typeof Characteristic;
  HapStatusError: new (status: number) => Error;
}

export interface BaseConfig {
  id: number;
  name?: string;
}

export interface LightConfig extends BaseConfig {
  dimmer?: boolean;
  where?: string;
  frame_on?: string;
  frame_off?: string;
  disableStatusQuery?: boolean;
}

export interface BlindConfig extends BaseConfig {
  time: number;
  timeSlat?: number;
  slatPercent?: number;
}

export interface ThermostatConfig extends BaseConfig {
  zone: number;
}

export interface ScenarioConfig extends BaseConfig {}
export interface ContactConfig extends BaseConfig {}
export interface EnergyConfig extends BaseConfig {}

class OwnAccessory {
  protected log: Logging;
  protected controller: OwnClient;
  protected Service: typeof Service;
  protected Characteristic: typeof Characteristic;
  protected HapStatusError: new (status: number) => Error;
  accessory: PlatformAccessory;
  name: string;
  protected id: number;
  protected category: string;

  constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: BaseConfig) {
    this.log = platform.log;
    this.controller = platform.controller;
    this.Service = platform.Service;
    this.Characteristic = platform.Characteristic;
    this.HapStatusError = platform.HapStatusError;
    this.accessory = accessory;

    this.name = config.name ?? "";
    this.id = config.id;
    this.category = "Accessory";

    if (!Number.isInteger(this.id) || this.id <= 0) {
      throw new Error(`homebridge-myhome: invalid accessory id "${config.id}" — must be a positive integer`);
    }

    this.accessory
      .getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, "MyHome Assistant")
      .setCharacteristic(this.Characteristic.Model, "Accessory")
      .setCharacteristic(this.Characteristic.SerialNumber, `MyHome-${this.id}`);
  }

  protected label(message: string): string {
    const normalized = message.replace(/^\[\d+\]\s*/, "");
    return `${this.category} [${this.id}] ${normalized}`;
  }

  updateStatus(): void {
    this.log.info(this.label("Accessory updateStatus"));
  }

  protected logFrameInfo(message: string, packet: string): void {
    this.log.info(`${this.label(message)} FRAME:${packet}`);
  }

  protected logFrameDebug(message: string, packet: string): void {
    this.log.debug(`${this.label(message)} FRAME:${packet}`);
  }

  protected logFrameWarn(message: string, packet: string): void {
    this.log.warn(`${this.label(message)} FRAME:${packet}`);
  }

  onData(packet: string): void {
    this.log.debug("OwnAccessory.OnData", packet);
  }

  checkWhere(where: string): boolean {
    const id = parseInt(where, 10);
    return this.id === id;
  }

  destroy(): void {}
}

export class OwnLightAccessory extends OwnAccessory {
  value: boolean;
  dimmer: boolean;
  brightness: number;
  where: string;
  frameOn?: string;
  frameOff?: string;
  disableStatusQuery: boolean;
  private dimmerOnTimeout: ReturnType<typeof setTimeout> | undefined;
  private lightbulbService: InstanceType<typeof Service>;

  constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: LightConfig) {
    if (!config.name) config.name = `light-${config.id}`;
    super(platform, accessory, config);
    this.category = "Light";

    this.value = false;
    this.dimmer = config.dimmer ?? false;
    this.brightness = 100;
    this.where = config.where ?? String(this.id);
    this.frameOn = config.frame_on?.trim();
    this.frameOff = config.frame_off?.trim();
    this.disableStatusQuery = config.disableStatusQuery ?? false;
    this.dimmerOnTimeout = undefined;

    this.accessory.getService(this.Service.AccessoryInformation)!.setCharacteristic(this.Characteristic.Model, "Light");

    this.lightbulbService = this.accessory.getService(this.Service.Lightbulb) ?? this.accessory.addService(this.Service.Lightbulb);

    this.lightbulbService
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.value)
      .onSet((value: CharacteristicValue) => {
        this.log.info(this.label(`Setting power state to ${value ? "on" : "off"}`));
        this.value = value as boolean;
        if (value && this.dimmer) {
          this.scheduleDimmerOn();
        } else {
          this.cancelDimmerOn();
          this.controller.sendCommand({ command: this.commandForPower(value as boolean), log: this.log });
        }
      });

    if (this.dimmer) {
      this.lightbulbService
        .getCharacteristic(this.Characteristic.Brightness)
        .onGet(() => this.brightness)
        .onSet((value: CharacteristicValue) => {
          this.log.info(this.label(`Setting brightness to ${value}`));
          this.cancelDimmerOn();
          this.brightness = value as number;
          if (value === 0) {
            this.value = false;
            this.lightbulbService.getCharacteristic(this.Characteristic.On).updateValue(false);
            this.controller.sendCommand({ command: this.commandForPower(false), log: this.log });
          } else {
            this.value = true;
            this.lightbulbService.getCharacteristic(this.Characteristic.On).updateValue(true);
            const level = this.brightnessToLevel(value as number);
            this.controller.sendCommand({ command: this.commandForLevel(level), log: this.log });
          }
        });
    }
  }

  updateStatus(): void {
    this.log.info(this.label("Light updateStatus"));
    if (this.disableStatusQuery) {
      this.log.info(this.label("Light status query disabled"));
      return;
    }
    this.controller.sendCommand({
      command: `*#1*${this.where}##`,
      log: this.log,
      packet: (pkt: string) => {
        const m = pkt.match(/^\*#1\*[\d#]+\*1\*(\d+)##$/);
        if (m) this.onData(`*1*${m[1]}*${this.where}##`);
      }
    });
  }

  private commandForPower(on: boolean): string {
    if (on && this.frameOn) return this.frameOn;
    if (!on && this.frameOff) return this.frameOff;
    return `*1*${on ? "1" : "0"}*${this.where}##`;
  }

  private scheduleDimmerOn(): void {
    this.cancelDimmerOn();
    this.dimmerOnTimeout = setTimeout(() => {
      this.dimmerOnTimeout = undefined;
      this.controller.sendCommand({ command: this.commandForLevel(this.brightnessToLevel(this.brightness)), log: this.log });
    }, 200);
  }

  private cancelDimmerOn(): void {
    clearTimeout(this.dimmerOnTimeout);
    this.dimmerOnTimeout = undefined;
  }

  private brightnessToLevel(brightness: number): number {
    return Math.min(10, Math.max(1, Math.ceil(brightness / 10)));
  }

  private commandForLevel(level: number): string {
    return `*1*${level}*${this.where}##`;
  }

  onData(packet: string): void {
    // Extended scenario/automation format *1*1000#<level>*<id>## — treat sub-level as the effective level
    const ext = packet.match(/^\*1\*1000#(\d+)\*[\d#]+##$/);
    const extract = ext ?? packet.match(/^\*1\*(\d+)\*[\d#]+##$/);
    if (extract) {
      this.logFrameDebug(`id:${this.id} onLight(${packet})`, packet);
      const level = parseInt(extract[1], 10);
      if (level === 0) {
        this.logFrameInfo("power off", packet);
        this.value = false;
      } else {
        this.logFrameInfo(`power on (level ${level})`, packet);
        this.value = true;
        if (this.dimmer && level >= 1) {
          this.brightness = Math.min(100, Math.max(1, level * 10));
          this.lightbulbService.getCharacteristic(this.Characteristic.Brightness).updateValue(this.brightness);
        }
      }
      this.lightbulbService.getCharacteristic(this.Characteristic.On).updateValue(this.value);
    } else {
      this.log.error("[%s] Light unknown packet:%s", this.id, packet);
    }
  }

  checkWhere(where: string): boolean {
    return where === this.where || super.checkWhere(where);
  }

  destroy(): void {
    this.cancelDimmerOn();
  }
}

export class OwnBlindAccessory extends OwnAccessory {
  time: number;
  timeSlat: number;
  slatPercent: number;
  state: number;
  expectedState: number;
  position: number;
  initStartPosition: boolean;
  commandSent: boolean;
  target: number;
  moveTrackingTimeout: ReturnType<typeof setTimeout> | undefined;
  packetTimeout: ReturnType<typeof setTimeout> | undefined;
  positionTimeout: ReturnType<typeof setTimeout> | undefined;
  moveRetries: number;
  initPhase: boolean;
  homeKitMovement: boolean;
  private inStatusQuery: boolean;
  private windowCoveringService: InstanceType<typeof Service>;

  constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: BlindConfig) {
    if (!config.name) config.name = `blind-${config.id}`;
    super(platform, accessory, config);
    this.category = "Blind";

    if (!config.time || config.time <= 0) {
      throw new Error(`homebridge-myhome: blind id=${config.id} requires a positive "time" value`);
    }
    this.time = config.time;
    this.timeSlat = config.timeSlat ?? 0;
    this.slatPercent = config.slatPercent ?? 0;

    this.state = this.Characteristic.PositionState.STOPPED;
    this.expectedState = this.Characteristic.PositionState.STOPPED;
    this.position = this.readCachedPosition();
    this.initStartPosition = false;
    this.commandSent = false;
    this.target = this.position;
    this.moveTrackingTimeout = undefined;
    this.packetTimeout = undefined;
    this.positionTimeout = undefined;
    this.moveRetries = 0;
    this.initPhase = false;
    this.homeKitMovement = false;
    this.inStatusQuery = false;

    this.accessory.getService(this.Service.AccessoryInformation)!.setCharacteristic(this.Characteristic.Model, "WindowCovering");

    this.windowCoveringService = this.accessory.getService(this.Service.WindowCovering) ?? this.accessory.addService(this.Service.WindowCovering);

    this.windowCoveringService.getCharacteristic(this.Characteristic.CurrentPosition).onGet(() => this.position);

    this.windowCoveringService
      .getCharacteristic(this.Characteristic.TargetPosition)
      .onGet(() => this.target)
      .onSet((target: CharacteristicValue) => {
        this.log.info(this.label(`Blind setting Target :${target}`));
        this.stopMoveTracking();
        this.target = target as number;
        this.move();
      });

    this.windowCoveringService.getCharacteristic(this.Characteristic.PositionState).onGet(() => this.state);

    this.windowCoveringService.getCharacteristic(this.Characteristic.HoldPosition).onSet((hold: CharacteristicValue) => {
      this.log.info(this.label(`Blind hold position :${hold}`));
      this.stopMoveTracking();
      this.target = this.position;
      this.move();
    });
  }

  updateStatus(): void {
    this.log.info(this.label("Blind updateStatus"));
    if (!this.initStartPosition) {
      this.log.info(this.label(`Initialization phase of blind: keep cached position ${this.position} without querying state`));
      this.initStartPosition = true;
    }
  }

  private readCachedPosition(): number {
    const position = this.accessory.context.blindPosition;
    return typeof position === "number" && Number.isFinite(position) ? Math.min(100, Math.max(0, Math.round(position))) : 0;
  }

  private cachePosition(): void {
    this.accessory.context.blindPosition = this.position;
  }

  private publishPosition(): void {
    this.windowCoveringService.getCharacteristic(this.Characteristic.CurrentPosition).updateValue(this.position);
    this.windowCoveringService.getCharacteristic(this.Characteristic.TargetPosition).updateValue(this.target);
    this.cachePosition();
  }

  private publishState(): void {
    this.windowCoveringService.getCharacteristic(this.Characteristic.PositionState).updateValue(this.state);
  }

  private finishMovementAt(position: number): void {
    clearTimeout(this.moveTrackingTimeout);
    this.moveTrackingTimeout = undefined;
    clearTimeout(this.positionTimeout);
    this.positionTimeout = undefined;
    clearTimeout(this.packetTimeout);
    this.packetTimeout = undefined;
    this.commandSent = false;
    this.homeKitMovement = false;
    this.moveRetries = 0;

    this.position = Math.min(100, Math.max(0, Math.round(position)));
    this.target = this.position;
    this.expectedState = this.Characteristic.PositionState.STOPPED;
    this.state = this.Characteristic.PositionState.STOPPED;

    this.publishState();
    this.publishPosition();
    this.log.info(this.label(`Blind movement finished locally pos:${this.position}`));
  }

  startTimerCommand(): void {
    clearTimeout(this.packetTimeout);
    this.packetTimeout = undefined;
    this.commandSent = true;
  }

  private startConfirmationTimer(): void {
    if (!this.commandSent) return;
    clearTimeout(this.packetTimeout);
    this.packetTimeout = setTimeout(this.endTimerCommand.bind(this), 1000);
  }

  endTimerCommand(): void {
    if (this.state !== this.expectedState) {
      this.state = this.expectedState;
      this.log.warn(this.label(`Blind command confirmation not received, forcing state to: ${this.expectedState}`));
      this.publishState();
      this.updateStatus();
    } else if (this.homeKitMovement) {
      // Absorb gateway echo packets (old-format STOP arriving after UP/DOWN confirmation)
      this.inStatusQuery = true;
      setTimeout(() => {
        this.inStatusQuery = false;
      }, 300);
    }
    this.commandSent = false;
    clearTimeout(this.packetTimeout);
  }

  commandIsPending(): boolean {
    return this.commandSent;
  }

  moveStop(): void {
    this.log.info(this.label("Blind sending stop"));
    this.homeKitMovement = false;
    this.expectedState = this.Characteristic.PositionState.STOPPED;
    this.startTimerCommand();
    this.controller.sendCommand({
      command: `*2*0*${this.id}##`,
      log: this.log,
      started: () => this.startConfirmationTimer()
    });
  }

  moveUp(): void {
    this.log.info(this.label("Blind sending move up"));
    this.homeKitMovement = true;
    this.expectedState = this.Characteristic.PositionState.INCREASING;
    this.startTimerCommand();
    this.controller.sendCommand({
      command: `*2*2*${this.id}##`,
      log: this.log,
      started: () => this.startConfirmationTimer()
    });
  }

  moveDown(): void {
    this.log.info(this.label("Blind sending move down"));
    this.homeKitMovement = true;
    this.expectedState = this.Characteristic.PositionState.DECREASING;
    this.startTimerCommand();
    this.controller.sendCommand({
      command: `*2*1*${this.id}##`,
      log: this.log,
      started: () => this.startConfirmationTimer()
    });
  }

  onData(packet: string): void {
    // Match standard *2*<dir>*<id>## OR extended *2*1000#<dir>*<id>## (same direction codes)
    const extract = packet.match(/^\*2\*(?:1000#)?(\d+)\*\d+##$/);
    if (extract) {
      this.log.debug("id:%s onBlind(%s)", this.id, packet);
      const direction = extract[1];
      const prevState = this.state;
      if (direction === "0") {
        const wasDecreasing = this.state === this.Characteristic.PositionState.DECREASING;
        this.state = this.Characteristic.PositionState.STOPPED;
        if (!this.initPhase || wasDecreasing) {
          this.initPhase = false;
        }
        if (Math.abs(this.position - this.target) <= 3) {
          this.position = this.target;
          this.cachePosition();
        }
      } else if (direction === "1") {
        this.state = this.Characteristic.PositionState.DECREASING;
      } else if (direction === "2") {
        this.state = this.Characteristic.PositionState.INCREASING;
      } else {
        this.log.warn("[%s] Blind unknown direction byte %s in packet %s", this.id, direction, packet);
        return;
      }
      this.publishState();
      this.logFrameInfo(`received state dir:${direction} position:${this.position} target:${this.target}`, packet);

      if (this.commandIsPending() && this.expectedState === this.state) {
        this.log.info(this.label(`expected state ${this.expectedState} reached`));
        this.endTimerCommand();
      } else if (this.homeKitMovement && this.state !== prevState && this.state !== this.expectedState && !this.inStatusQuery) {
        // Physical button pressed while HomeKit movement was in progress — yield immediately
        this.log.info(this.label("Physical override detected, cancelling HomeKit movement"));
        this.stopMoveTracking();
      }

      // Skip evaluatePosition for duplicate packets that don't change state
      if (!this.commandIsPending() && !this.positionTimeout && this.state !== prevState) {
        this.evaluatePosition();
      }
    } else {
      this.log.debug("[%s] Blind ignoring extended packet:%s", this.id, packet);
    }
  }

  evaluatePosition(): void {
    clearTimeout(this.positionTimeout);
    if (this.state === this.Characteristic.PositionState.STOPPED) {
      this.log.info(this.label(`Blind is STOPPED pos:${this.position} target:${this.target}`));
    } else if (this.state === this.Characteristic.PositionState.INCREASING) {
      if (this.position < 100) this.position++;
      if (this.position % 10 === 0 || this.position >= this.target)
        this.log.info(this.label(`Blind moving UP pos:${this.position} target:${this.target}`));
      if (this.homeKitMovement && this.position >= this.target) {
        this.moveStop();
      } else if (!this.homeKitMovement && this.position >= 100) {
        this.finishMovementAt(100);
      } else {
        this.startPositionTracking();
      }
    } else if (this.state === this.Characteristic.PositionState.DECREASING) {
      if (this.position > 0) this.position--;
      if (this.position % 10 === 0 || this.position <= this.target)
        this.log.info(this.label(`Blind moving DOWN pos:${this.position} target:${this.target}`));
      if (!this.initPhase && this.homeKitMovement && this.position <= this.target) {
        this.moveStop();
      } else if (this.initPhase && this.position === 0) {
        // at physical end-stop during init — wait for gateway STOP packet, do not reschedule
      } else if (!this.homeKitMovement && this.position <= 0) {
        this.finishMovementAt(0);
      } else {
        this.startPositionTracking();
      }
    }
    this.publishPosition();
  }

  msPerPercent(position: number): number {
    if (this.slatPercent > 0 && position < this.slatPercent) {
      return Math.max(50, (this.timeSlat / this.slatPercent) * 1000);
    }
    return (this.time / Math.max(1, 100 - this.slatPercent)) * 1000;
  }

  startPositionTracking(): void {
    clearTimeout(this.positionTimeout);
    this.positionTimeout = setTimeout(this.evaluatePosition.bind(this), this.msPerPercent(this.position));
  }

  move(): void {
    if (this.commandIsPending()) {
      this.log.info(this.label("Blind command is still pending: wait for action"));
      clearTimeout(this.moveTrackingTimeout);
      this.moveTrackingTimeout = setTimeout(this.move.bind(this), 500);
      return;
    }
    if (this.target < this.position) {
      if (this.state === this.Characteristic.PositionState.INCREASING) {
        this.moveStop();
      } else if (
        this.state !== this.Characteristic.PositionState.DECREASING &&
        (this.state === this.Characteristic.PositionState.STOPPED || Math.abs(this.target - this.position) > 2)
      ) {
        this.moveDown();
      }
    } else if (this.target > this.position) {
      if (this.state === this.Characteristic.PositionState.DECREASING) {
        this.moveStop();
      } else if (
        this.state !== this.Characteristic.PositionState.INCREASING &&
        (this.state === this.Characteristic.PositionState.STOPPED || Math.abs(this.target - this.position) > 2)
      ) {
        this.moveUp();
      }
    } else {
      if (this.state !== this.Characteristic.PositionState.STOPPED) {
        this.moveStop();
      }
      this.log.info(this.label(`Blind position is good: stop moving ${this.position} target:${this.target}`));
      return;
    }
    if (!this.commandSent && !this.positionTimeout) {
      this.startPositionTracking();
    }
    this.startMoveTracking();
  }

  startMoveTracking(): void {
    clearTimeout(this.moveTrackingTimeout);
    this.moveTrackingTimeout = undefined;
    if (this.commandSent) {
      this.moveRetries++;
    }
    if (this.moveRetries > 30) {
      this.log.warn("[%s] Blind giving up after too many move retries", this.id);
      this.finishMovementAt(this.position);
      return;
    }
    this.moveTrackingTimeout = setTimeout(this.move.bind(this), 500);
  }

  stopMoveTracking(): void {
    clearTimeout(this.moveTrackingTimeout);
    this.moveTrackingTimeout = undefined;
    clearTimeout(this.positionTimeout);
    this.positionTimeout = undefined;
    clearTimeout(this.packetTimeout);
    this.packetTimeout = undefined;
    this.commandSent = false;
    this.homeKitMovement = false;
    this.moveRetries = 0;
  }

  destroy(): void {
    clearTimeout(this.moveTrackingTimeout);
    clearTimeout(this.packetTimeout);
    clearTimeout(this.positionTimeout);
  }
}

export class OwnThermostatAccessory extends OwnAccessory {
  zone: number;
  address: string;
  temperature: number;
  targetTemperature: number;
  localOffset: number;
  heatingCoolingState: number;
  targetHeatingCoolingState: number;
  displayUnits: number;
  private thermostatService: InstanceType<typeof Service>;

  constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: ThermostatConfig) {
    if (!config.name) config.name = `thermostat-${config.id}`;
    super(platform, accessory, config);
    this.category = "Thermostat";

    if (!Number.isInteger(config.zone) || config.zone <= 0) {
      throw new Error(`homebridge-myhome: thermostat id=${config.id} requires a positive integer "zone"`);
    }
    this.zone = config.zone;
    this.address = `#0#${this.zone}`;

    this.temperature = 0;
    this.targetTemperature = 0;
    this.localOffset = 0;
    this.heatingCoolingState = this.Characteristic.CurrentHeatingCoolingState.OFF;
    this.targetHeatingCoolingState = this.Characteristic.TargetHeatingCoolingState.OFF;
    this.displayUnits = this.Characteristic.TemperatureDisplayUnits.CELSIUS;

    this.accessory.getService(this.Service.AccessoryInformation)!.setCharacteristic(this.Characteristic.Model, "Thermostat");

    this.thermostatService = this.accessory.getService(this.Service.Thermostat) ?? this.accessory.addService(this.Service.Thermostat);

    this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState).onGet(() => this.heatingCoolingState);

    this.thermostatService
      .getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [0, 1, 3] })
      .onGet(() => this.targetHeatingCoolingState)
      .onSet((value: CharacteristicValue) => {
        this.targetHeatingCoolingState = value as number;
        this.log.info(this.label(`zone[${this.zone}] setTargetHeatingCoolingState:${value}`));
        switch (value) {
          case this.Characteristic.TargetHeatingCoolingState.HEAT: {
            const temperature = OwnProtcol.encodeTemperature(this.targetTemperature);
            this.log.info(this.label(`send Heat Manual at ${temperature}`));
            this.controller.sendCommand({ command: `*#4*${this.address}*#14*${temperature}*1##`, log: this.log });
            break;
          }
          case this.Characteristic.TargetHeatingCoolingState.OFF:
            this.controller.sendCommand({ command: `*4*103*${this.address}##`, log: this.log });
            this.log.info(this.label("send STOP"));
            break;
          case this.Characteristic.TargetHeatingCoolingState.AUTO:
            this.controller.sendCommand({ command: `*4*3100*${this.address}##`, log: this.log });
            this.log.info(this.label("send AUTO"));
            break;
        }
      });

    this.thermostatService
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, minStep: 0.1, maxValue: 50 })
      .onGet(() => this.temperature);

    this.thermostatService
      .getCharacteristic(this.Characteristic.TargetTemperature)
      .setProps({ minValue: -50, minStep: 0.1, maxValue: 50 })
      .onGet(() => this.targetTemperature)
      .onSet((value: CharacteristicValue) => {
        this.log.info(this.label(`zone[${this.zone}] setTargetTemperature:${value}`));
        if (this.targetHeatingCoolingState !== this.Characteristic.TargetHeatingCoolingState.HEAT) {
          this.log.error("Can't change target temperature with mode (%s)", this.targetHeatingCoolingState);
          throw new this.HapStatusError(-70412);
        }
        this.targetTemperature = value as number;
        const temperature = OwnProtcol.encodeTemperature(value as number);
        this.controller.sendCommand({ command: `*#4*${this.address}*#14*${temperature}*1##`, log: this.log });
      });

    this.thermostatService
      .getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.displayUnits)
      .onSet((value: CharacteristicValue) => {
        this.displayUnits = value as number;
      });
  }

  updateStatus(): void {
    this.log.info(this.label("Thermostat updateStatus"));
    const handler = (pkt: string) => {
      this.onData(pkt);
    };
    this.controller.sendCommand({ command: `*#4*${this.address}##`, log: this.log, packet: handler });
    this.controller.sendCommand({ command: `*#4*${this.id}##`, log: this.log, packet: handler });
  }

  checkWhere(where: string): boolean {
    return this.address === where || super.checkWhere(where);
  }

  updateCharacteristicCurrentTemperature(temperature: number): void {
    this.log.info(this.label(`update CurrentTemperature (${temperature})`));
    this.temperature = temperature;
    this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature).updateValue(this.temperature);
  }

  updateCharacteristicTargetTemperature(temperature: number): void {
    this.log.info(this.label(`update TargetTemperature (${temperature})`));
    this.targetTemperature = temperature;
    this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature).updateValue(this.targetTemperature);
  }

  updateCharacteristicTargetHeatingCoolingState(state: number): void {
    this.log.info(this.label(`update TargetHeatingCoolingState (${state})`));
    this.targetHeatingCoolingState = state;
    this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState).updateValue(this.targetHeatingCoolingState);
  }

  updateCharacteristicCurrentHeatingCoolingState(state: number): void {
    this.log.info(this.label(`update CurrentHeatingCoolingState (${state})`));
    this.heatingCoolingState = state;
    this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState).updateValue(this.heatingCoolingState);
  }

  onData(packet: string): void {
    let extract: RegExpMatchArray | null;
    if ((extract = packet.match(/^\*#4\*\d+\*0\*(\d+)##$/))) {
      this.updateCharacteristicCurrentTemperature(OwnProtcol.decodeTemperature(extract[1]));
    } else if ((extract = packet.match(/^\*#4\*\d+\*12\*(\d+)\*3##$/))) {
      const probeTemp = OwnProtcol.decodeTemperature(extract[1]);
      this.log.debug(this.label(`zone[${this.zone}] probe temperature with local offset (${probeTemp})`));
    } else if ((extract = packet.match(/^\*#4\*\d+\*13\*(\d+)##$/))) {
      let status = "Local ON";
      const value = extract[1];
      if (value === "00") this.localOffset = 0;
      else if (value === "01") this.localOffset = 1;
      else if (value === "11") this.localOffset = -1;
      else if (value === "02") this.localOffset = 2;
      else if (value === "12") this.localOffset = -2;
      else if (value === "03") this.localOffset = 3;
      else if (value === "13") this.localOffset = -3;
      else if (value === "04") {
        this.localOffset = 0;
        status = "Local OFF";
      } else if (value === "05") {
        this.localOffset = 0;
        status = "Local protection";
      } else {
        this.log.warn("[%s] zone[%s] unknown DIM 13 value (%s) in packet: %s", this.id, this.zone, value, packet);
      }
      this.log.debug("[%s] zone[%s] local offset:%s (%s)", this.id, this.zone, this.localOffset, status);
    } else if ((extract = packet.match(/^\*#4\*[\d#]+\*14\*(\d+)\*\d+##$/))) {
      this.updateCharacteristicTargetTemperature(OwnProtcol.decodeTemperature(extract[1]));
    } else if ((extract = packet.match(/^\*#4\*[\d#]+\*19\*(\d)\*(\d)##$/))) {
      const CV = extract[1];
      const HV = extract[2];
      const coolingActive = ["1", "2"].includes(CV);
      const heatingActive = ["1", "2"].includes(HV);
      if (heatingActive) {
        this.log.debug(this.label(`zone[${this.zone}] heating ON`));
        this.updateCharacteristicCurrentHeatingCoolingState(this.Characteristic.CurrentHeatingCoolingState.HEAT);
      } else if (coolingActive) {
        this.log.debug(this.label(`zone[${this.zone}] cooling ON`));
        this.updateCharacteristicCurrentHeatingCoolingState(this.Characteristic.CurrentHeatingCoolingState.COOL);
      } else {
        this.log.debug(this.label(`zone[${this.zone}] heating/cooling OFF`));
        this.updateCharacteristicCurrentHeatingCoolingState(this.Characteristic.CurrentHeatingCoolingState.OFF);
      }
    } else if ((extract = packet.match(/^\*#4\*\d+#\d+\*20\*(\d+)##$/))) {
      let status = "";
      const value = extract[1];
      if (value === "0") status = "OFF";
      else if (value === "1") status = "ON";
      else if (value === "4") status = "STOP";
      else status = `not decoded:${value}`;
      this.log.debug(this.label(`zone[${this.zone}] actuator status (${status})`));
    } else if ((extract = packet.match(/^\*4\*(\d+)\*\d+##$/))) {
      let status = "";
      const value = extract[1];
      if (value === "0") status = "Conditioning";
      else if (value === "1") status = "Heating";
      else if (value === "102") status = "Antifreeze";
      else if (value === "202") status = "Thermal Protection";
      else if (value === "303") status = "Generic OFF";
      else this.log.error("[%s] zone[%s] operation mode (%s)", this.id, this.zone, value);
      this.log.debug(this.label(`zone[${this.zone}] operation mode (${status})`));
      const hkCurrentState =
        value === "1" || value === "102"
          ? this.Characteristic.CurrentHeatingCoolingState.HEAT
          : value === "0"
            ? this.Characteristic.CurrentHeatingCoolingState.COOL
            : this.Characteristic.CurrentHeatingCoolingState.OFF;
      this.updateCharacteristicCurrentHeatingCoolingState(hkCurrentState);
    } else if ((extract = packet.match(/^\*4\*(\d+)\*#\d+#\d+##$/))) {
      const valInt = parseInt(extract[1], 10);
      if (valInt === 103) {
        this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.OFF);
        this.log.debug("[%s] zone[%s] operation mode Heating OFF", this.id, this.zone);
      } else if (valInt === 102) {
        this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.OFF);
        this.log.debug("[%s] zone[%s] operation mode Anti Freeze", this.id, this.zone);
      } else if (valInt === 1101 || valInt === 1102 || valInt === 1103) {
        this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.AUTO);
        this.log.debug("[%s] zone[%s] operation mode Heating program", this.id, this.zone);
      } else if (valInt > 13000 && valInt <= 13255) {
        const days = valInt - 13000;
        this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.AUTO);
        this.log.debug("[%s] zone[%s] operation mode Holiday program for %s day", this.id, this.zone, days);
      } else if (valInt === 21) {
        this.log.debug("[%s] zone[%s] Remote control enabled", this.id, this.zone);
      } else if (valInt === 0) {
        this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.OFF);
        this.log.debug("[%s] zone[%s] operation mode Conditioning (generic OFF)", this.id, this.zone);
      } else {
        this.log.error("[%s] zone[%s] unknown value (%i) in packet: %s", this.id, this.zone, valInt, packet);
      }
    } else if ((extract = packet.match(/^\*4\*(\d+)#(\d+)\*#\d+#\d+##$/))) {
      const value = extract[1];
      if (value === "110") {
        const temp = OwnProtcol.decodeTemperature(extract[2]);
        this.log.debug("[%s] zone[%s] operation mode Manual Heating (%s)", this.id, this.zone, temp);
        this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.HEAT);
        this.updateCharacteristicTargetTemperature(temp);
      }
    } else {
      this.log.error("[%s] zone[%s] unknown packet: %s", this.id, this.zone, packet);
    }
  }
}

export class OwnScenarioAccessory extends OwnAccessory {
  private resetTimeout: ReturnType<typeof setTimeout> | undefined;
  private switchService: InstanceType<typeof Service>;

  constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: ScenarioConfig) {
    if (!config.name) config.name = `scenario-${config.id}`;
    super(platform, accessory, config);
    this.category = "Scenario";

    this.resetTimeout = undefined;

    this.accessory.getService(this.Service.AccessoryInformation)!.setCharacteristic(this.Characteristic.Model, "Scenario");

    this.switchService = this.accessory.getService(this.Service.Switch) ?? this.accessory.addService(this.Service.Switch);

    this.switchService
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => false)
      .onSet((value: CharacteristicValue) => {
        if (value) {
          this.log.info(this.label("Scenario activate"));
          this.controller.sendCommand({ command: `*0*${this.id}*0##`, log: this.log });
          clearTimeout(this.resetTimeout);
          this.resetTimeout = setTimeout(() => {
            this.switchService.getCharacteristic(this.Characteristic.On).updateValue(false);
          }, 500);
        }
      });
  }

  onData(_packet: string): void {}
  checkWhere(_where: string): boolean {
    return false;
  }
  destroy(): void {
    clearTimeout(this.resetTimeout);
  }
}

export class OwnContactAccessory extends OwnAccessory {
  contactState: number;
  private contactService: InstanceType<typeof Service>;

  constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: ContactConfig) {
    if (!config.name) config.name = `contact-${config.id}`;
    super(platform, accessory, config);
    this.category = "Contact";

    this.contactState = this.Characteristic.ContactSensorState.CONTACT_DETECTED;

    this.accessory.getService(this.Service.AccessoryInformation)!.setCharacteristic(this.Characteristic.Model, "ContactSensor");

    this.contactService = this.accessory.getService(this.Service.ContactSensor) ?? this.accessory.addService(this.Service.ContactSensor);

    this.contactService.getCharacteristic(this.Characteristic.ContactSensorState).onGet(() => this.contactState);
  }

  updateStatus(): void {
    this.log.info(this.label("Contact updateStatus"));
    this.controller.sendCommand({
      command: `*#9*${this.id}##`,
      log: this.log,
      packet: (pkt: string) => {
        this.onData(pkt);
      }
    });
  }

  onData(packet: string): void {
    const extract = packet.match(/^\*9\*(\d+)\*\d+##$/);
    if (extract) {
      this.contactState =
        extract[1] === "0" ? this.Characteristic.ContactSensorState.CONTACT_DETECTED : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
      this.log.info(this.label(`Contact state: ${this.contactState}`));
      this.contactService.getCharacteristic(this.Characteristic.ContactSensorState).updateValue(this.contactState);
    } else {
      this.log.error("[%s] Contact unknown packet:%s", this.id, packet);
    }
  }
}

export class OwnEnergyAccessory extends OwnAccessory {
  watts: number;
  private energyService: InstanceType<typeof Service>;
  private pollInterval: ReturnType<typeof setInterval>;

  constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: EnergyConfig) {
    if (!config.name) config.name = `energy-${config.id}`;
    super(platform, accessory, config);
    this.category = "Energy";

    this.watts = 0.0001;

    this.accessory.getService(this.Service.AccessoryInformation)!.setCharacteristic(this.Characteristic.Model, "EnergyMonitor");

    this.energyService = this.accessory.getService(this.Service.LightSensor) ?? this.accessory.addService(this.Service.LightSensor);

    this.energyService.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel).onGet(() => Math.max(0.0001, this.watts));

    this.pollInterval = setInterval(() => {
      if (this.controller.queueSize() < 10) this.updateStatus();
    }, 30000);
  }

  destroy(): void {
    clearInterval(this.pollInterval);
  }

  updateStatus(): void {
    this.log.debug(this.label("Energy updateStatus"));
    this.controller.sendCommand({
      command: `*#18*${this.id}*113##`,
      log: this.log,
      packet: (pkt: string) => {
        this.onData(pkt);
      }
    });
  }

  onData(packet: string): void {
    const extract = packet.match(/^\*#18\*\d+\*113\*(\d+)##$/);
    if (extract) {
      this.watts = Math.max(0.0001, parseInt(extract[1], 10));
      this.log.debug(this.label(`Energy: ${this.watts}W`));
      this.energyService.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel).updateValue(this.watts);
    } else {
      this.log.debug("[%s] Energy: ignoring packet %s", this.id, packet);
    }
  }
}
