/**
 * GoHighLevel Media Upload Utility
 *
 * Uploads images to a GHL sub-account's media storage
 * using the Private Integration API key (PIT).
 *
 * API: POST https://services.leadconnectorhq.com/medias/upload-file
 *
 * Folder placement: GHL ignores `folderId` as a multipart form field and
 * has been observed to ignore the `?folderId=` URL query in some accounts.
 * The proven, reliable approach (battle-tested in moshbari/everylink) is to
 * pass folder placement via THREE form fields:
 *
 *   - parentId  = <FOLDER_ID>
 *   - altId     = <LOCATION_ID>
 *   - altType   = "location"
 *
 * We also keep ?folderId=<ID> on the URL as a belt-and-suspenders fallback.
 */

const GHL_API_BASE = "https://services.leadconnectorhq.com";

interface GHLUploadResponse {
  url: string;
  name: string;
  id: string;
  [key: string]: unknown;
}

export function isGHLConfigured(): boolean {
  return !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID);
}

/**
 * Upload an image buffer to GoHighLevel media storage.
 *
 * @param imageBuffer - The image data as a Buffer or ArrayBuffer
 * @param filename    - Plain filename (no folder path), e.g. "my-image.png"
 * @returns The permanent GHL CDN URL (assets.cdn.filesafe.space/...)
 */
export async function uploadToGHL(
  imageBuffer: Buffer | ArrayBuffer,
  filename: string
): Promise<string> {
  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const mediaFolder = process.env.GHL_MEDIA_FOLDER; // folder ID, e.g. "69e0557780b446d0fbdc8913"

  if (!apiKey || !locationId) {
    throw new Error("GHL_API_KEY and GHL_LOCATION_ID must be set in environment variables");
  }

  const buffer = imageBuffer instanceof Buffer
    ? imageBuffer
    : Buffer.from(imageBuffer);

  // Build multipart form data per the playbook (everylink-style).
  // IMPORTANT: `name` must be a plain filename, never "folder/name".
  const formData = new FormData();
  const blob = new Blob([buffer], { type: "image/png" });
  formData.append("file", blob, filename);
  formData.append("hosted", "false");
  formData.append("name", filename);

  // Required for folder placement on PIT-authed uploads:
  formData.append("altId", locationId);
  formData.append("altType", "location");
  if (mediaFolder) {
    formData.append("parentId", mediaFolder);
  }

  // Belt-and-suspenders: also include folderId on the URL.
  const uploadUrl = mediaFolder
    ? `${GHL_API_BASE}/medias/upload-file?folderId=${encodeURIComponent(mediaFolder)}`
    : `${GHL_API_BASE}/medias/upload-file`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Version": "2021-07-28",
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("GHL upload failed:", response.status, errorText);
    throw new Error(`GHL media upload failed (${response.status}): ${errorText}`);
  }

  const data: GHLUploadResponse = await response.json();

  if (!data.url) {
    throw new Error("GHL upload response did not include a URL");
  }

  return data.url;
}

/**
 * Upload an image from a remote URL to GHL media storage.
 * Fetches the image first, then uploads the buffer.
 */
export async function uploadFromUrlToGHL(
  imageUrl: string,
  filename: string
): Promise<string> {
  const imageResponse = await fetch(imageUrl);

  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch image from source URL (${imageResponse.status})`);
  }

  const imageBuffer = await imageResponse.arrayBuffer();
  return uploadToGHL(Buffer.from(imageBuffer), filename);
}

/**
 * Upload a base64-encoded image (data URL or raw base64) to GHL media storage.
 */
export async function uploadBase64ToGHL(
  base64Data: string,
  filename: string
): Promise<string> {
  const raw = base64Data.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(raw, "base64");
  return uploadToGHL(buffer, filename);
}
