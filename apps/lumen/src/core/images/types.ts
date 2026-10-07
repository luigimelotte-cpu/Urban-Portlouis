import type { ModelCapabilities } from "../content/policy";
import type { ProviderDescriptor } from "../providers/types";

export type ImageKind = "PORTRAIT" | "SELFIE" | "SCENE";
export type ImageStyle = "photoreal" | "cinematic" | "illustration";
export type ImageAspect = "portrait" | "square" | "landscape";

export interface ImageRequest {
  prompt: string;
  negativePrompt?: string;
  aspect: ImageAspect;
  /** Same seed + same identity text → more consistent faces on providers that honour it. */
  seed?: number;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
  width?: number;
  height?: number;
  model: string;
}

/** Image backends implement this; nothing above it knows the vendor. */
export interface ImageProvider {
  readonly descriptor: ProviderDescriptor;
  generate(req: ImageRequest): Promise<GeneratedImage>;
  getCapabilities(): ModelCapabilities;
  isAvailable(): boolean;
}

export class ImageProviderError extends Error {
  constructor(message: string, readonly providerId: string, readonly retryable = false) {
    super(message);
    this.name = "ImageProviderError";
  }
}

/** Sniff the real type from the first bytes instead of trusting a header. */
export function detectMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  const head = new TextDecoder().decode(bytes.slice(0, 200)).trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return null;
}
