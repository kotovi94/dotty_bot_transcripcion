import type { DottyDesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    dotty: DottyDesktopApi;
  }
}

export {};
