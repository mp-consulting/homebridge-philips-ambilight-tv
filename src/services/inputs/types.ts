import type { Service } from 'homebridge';

// ============================================================================
// TYPES
// ============================================================================

/** Input source type for HomeKit categorization */
export type InputType = 'app' | 'source' | 'channel';

/** Which HomeKit control a source selection arrived from. The two are not
 *  interchangeable when they disagree — see SWITCH_PRECEDENCE_MS. */
export type SelectionOrigin = 'wheel' | 'switch';

/** Runtime input source with associated HomeKit service */
export interface InputSource {
  readonly id: string;
  /** Display/base name. Mutable so a package-id placeholder (used when a source
   *  is registered before the TV reports its label) can be upgraded to the real
   *  app name once the TV becomes reachable. */
  name: string;
  readonly type: InputType;
  readonly identifier: number;
  readonly service: Service;
  /** Explicit launch activity for custom apps (apps the TV does not report). */
  readonly className?: string;
  /** Explicit launch intent action for custom apps. */
  readonly action?: string;
}

/** Persisted input source configuration (accessory context + cache file) */
export interface InputSourceConfig {
  readonly id: string;
  readonly name: string;
  readonly configuredName: string;
  readonly type: InputType;
  readonly identifier: number;
  readonly visibility: number;
}

/** Raw input data before HomeKit service creation */
export interface InputData {
  readonly id: string;
  readonly name: string;
  readonly type: InputType;
  readonly className?: string;
  readonly action?: string;
}

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
