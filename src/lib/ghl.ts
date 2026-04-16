/**
 * GoHighLevel Media Upload Utility
 *
 * Uploads images to a GHL sub-account's media storage
 * using the Private Integration API key.
 *
 * API: POST https://services.leadconnectorhq.com/medias/upload-file
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

export async function uploadToGHL(
  imageBuffer: Buffer | ArrayBuffer,
  filename: string
): Promise<string> {
  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const mediaFolder = process.env.GHL_MEDIA_FOLDER;

  if (!apiKey || !locationId) {
    throw new Error("GHL_API_KEY and GHL_LOCATION_ID must be set");
  }

  const buffer = imageBuffer instanceof Buffer
    ? imageBuffer
    : Buffer.from(imageBuffer);

  // Build multipart form data
  const formData = new FormData();
  const blob = new Blob([buffer], { type: "image/png" });
  formData.append("file", blob, filename);
  formData.append("hosted", "false");
  formData.append("name", filename);
  if (mediaFolder) {
    formData.append("folderId", mediaFolder);
  }

  const response = await fetch(`${GHL_API_BASE}/medias/upload-file`, {
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

export async function uploadBase64ToGHL(
  base64Data: string,
  filename: string
): Promise<string> {
  const raw = base64Data.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(raw, "base64");
  return uploadToGHL(buffer, filename);
}
