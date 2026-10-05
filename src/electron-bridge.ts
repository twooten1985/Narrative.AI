export type SecretName = "assemblyai" | "gemini";

export interface ElectronBridge {
  platform: string;
  writeClipboardText: (text: string) => boolean;
  secrets: {
    setKey: (name: SecretName, value: string) => Promise<{ ok: boolean; error?: string }>;
    clearKey: (name: SecretName) => Promise<{ ok: boolean; error?: string }>;
    hasKey: (name: SecretName) => Promise<boolean>;
  };
  getSessionToken: () => Promise<string>;
  pathForFile?: (file: File) => string;
  allowPath?: (filePath: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  pickMediaFiles?: () => Promise<string[]>;
  reload?: () => Promise<void>;
  exportPdf: (payload: {
    html: string;
    defaultFilename: string;
    footerNote: string;
    auditLine: string;
    headerText?: string;
  }) => Promise<{ canceled: boolean; filePath?: string; error?: string }>;
}

export function getElectron(): ElectronBridge | null {
  const bridge = (window as Window & { electron?: ElectronBridge }).electron;
  if (!bridge?.secrets || !bridge.getSessionToken) return null;
  return bridge;
}
