import type { ModelCapabilities } from "../../content/policy";
import type { ProviderDescriptor } from "../../providers/types";
import type { GeneratedImage, ImageProvider, ImageRequest } from "../types";

/**
 * Offline stand-in: draws an SVG "photo" (gradient, soft light, the shot
 * description as a caption) so the whole image flow works with no API key.
 */
export class MockImageProvider implements ImageProvider {
  constructor(readonly descriptor: ProviderDescriptor) {}
  getCapabilities(): ModelCapabilities {
    return this.descriptor.capabilities;
  }
  isAvailable() {
    return true;
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const delay = Number(this.descriptor.options?.delayMs ?? 900);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const [w, h] = req.aspect === "portrait" ? [768, 1024] : req.aspect === "square" ? [896, 896] : [1024, 768];
    const seed = hash(req.prompt + (req.seed ?? 0));
    const hue = seed % 360;
    const caption = req.prompt.split(".")[0].replace(/^(Candid smartphone selfie of|Head-and-shoulders portrait of)\s*/i, "").slice(0, 90);
    const esc = (s: string) => s.replace(/[<>&"]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[m] as string);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},45%,22%)"/></linearGradient>
<radialGradient id="l" cx="0.3" cy="0.25" r="0.7"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#l)"/>
<ellipse cx="${w / 2}" cy="${h * 0.42}" rx="${w * 0.16}" ry="${w * 0.2}" fill="#000" fill-opacity=".18"/>
<path d="M${w * 0.22} ${h} C ${w * 0.25} ${h * 0.68}, ${w * 0.75} ${h * 0.68}, ${w * 0.78} ${h} Z" fill="#000" fill-opacity=".18"/>
<text x="32" y="${h - 64}" font-family="Georgia,serif" font-size="26" fill="#fff" fill-opacity=".9">${esc(caption)}</text>
<text x="32" y="${h - 28}" font-family="sans-serif" font-size="18" fill="#fff" fill-opacity=".6">mock image · configure an image model in /admin</text></svg>`;
    return { bytes: new TextEncoder().encode(svg), mimeType: "image/svg+xml", width: w, height: h, model: "mock-images" };
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
