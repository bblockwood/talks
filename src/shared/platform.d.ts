// Minimal typings for browser APIs that TypeScript's DOM lib doesn't cover yet.
// All are optional: always feature-detect at runtime.

interface ScreenDetailed extends Screen {
  readonly left: number;
  readonly top: number;
  readonly availLeft: number;
  readonly availTop: number;
  readonly isPrimary: boolean;
  readonly isInternal: boolean;
  readonly devicePixelRatio: number;
  readonly label: string;
}

interface ScreenDetails extends EventTarget {
  readonly screens: readonly ScreenDetailed[];
  readonly currentScreen: ScreenDetailed;
}

interface Window {
  getScreenDetails?: () => Promise<ScreenDetails>;
}

interface Screen {
  readonly isExtended?: boolean;
}

interface FullscreenOptions {
  screen?: ScreenDetailed;
}

interface KeyboardLockApi {
  lock?: (keyCodes?: string[]) => Promise<void>;
  unlock?: () => void;
}

interface Navigator {
  readonly keyboard?: KeyboardLockApi;
}
