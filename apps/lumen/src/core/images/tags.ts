// The chat model "sends" a photo by writing a line like
//   [photo: selfie in the studio, holding up the finished sketch]
// The pipeline strips these lines from the text and turns each into an image.

const TAG = /\[(?:photo|pic|picture|image|selfie)\s*:\s*([^\]\n]{3,300})\]/gi;
const PARTIAL = /\[(?:photo|pic|picture|image|selfie)\s*:[^\]\n]*\]?/gi;

export const MAX_PHOTOS_PER_MESSAGE = 1;

export function extractPhotoTags(text: string): { text: string; photos: string[] } {
  const photos: string[] = [];
  for (const m of text.matchAll(TAG)) photos.push(m[1].trim());
  const clean = text
    .replace(TAG, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n\|\|\n(\s*\n\|\|\n)+/g, "\n||\n")
    .replace(/^(\s*\|\|\s*\n)+|(\n\s*\|\|\s*)+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: clean, photos: photos.slice(0, MAX_PHOTOS_PER_MESSAGE) };
}

/** For live streaming: hide a tag that is still being typed. */
export function hidePhotoTags(text: string): string {
  return text.replace(PARTIAL, "").replace(/\n{3,}/g, "\n\n");
}
