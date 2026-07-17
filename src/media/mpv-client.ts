import { invoke, isTauri } from "@tauri-apps/api/core";

export interface MpvBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MpvCapability {
  available: boolean;
  error?: string;
}

export interface MpvPlaybackState {
  ready: boolean;
  duration: number;
  currentTime: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  ended: boolean;
  hasAudio?: boolean;
  error?: string;
}

export interface MpvClient {
  probe(): Promise<MpvCapability>;
  create(bounds: MpvBounds): Promise<void>;
  load(path: string, initialPosition: number): Promise<void>;
  setBounds(bounds: MpvBounds): Promise<void>;
  state(): Promise<MpvPlaybackState>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(position: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  destroy(): Promise<void>;
}

export function elementBounds(element: HTMLElement): MpvBounds {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export const nativeMpvClient: MpvClient = {
  async probe() {
    if (!isTauri()) return { available: false };
    return invoke<MpvCapability>("mpv_probe");
  },
  create(bounds) {
    return invoke("mpv_create", { bounds });
  },
  load(path, initialPosition) {
    return invoke("mpv_load", { path, initialPosition });
  },
  setBounds(bounds) {
    return invoke("mpv_set_bounds", { bounds });
  },
  state() {
    return invoke<MpvPlaybackState>("mpv_state");
  },
  play() {
    return invoke("mpv_play");
  },
  pause() {
    return invoke("mpv_pause");
  },
  seek(position) {
    return invoke("mpv_seek", { position });
  },
  setVolume(volume) {
    return invoke("mpv_set_volume", { volume });
  },
  setMuted(muted) {
    return invoke("mpv_set_muted", { muted });
  },
  destroy() {
    return invoke("mpv_destroy");
  },
};
