import type { ProviderDescriptor } from "../providers/types";
import { MockImageProvider } from "./adapters/mock-images";
import { OpenAIImagesProvider } from "./adapters/openai-images";
import type { ImageProvider } from "./types";

const ADAPTERS: Record<string, { label: string; create: (d: ProviderDescriptor) => ImageProvider }> = {
  "openai-images": { label: "Images: OpenAI-compatible (OpenAI, Together, DeepInfra…)", create: (d) => new OpenAIImagesProvider(d) },
  "mock-images": { label: "Images: mock (offline dev)", create: (d) => new MockImageProvider(d) },
};

export const isImageAdapter = (key: string) => key in ADAPTERS;
export const imageAdapterOptions = () => Object.entries(ADAPTERS).map(([key, v]) => ({ key, label: v.label }));

export function createImageProvider(d: ProviderDescriptor): ImageProvider {
  const a = ADAPTERS[d.adapter];
  if (!a) throw new Error(`Unknown image adapter "${d.adapter}"`);
  return a.create(d);
}
