/**
 * OpenGraph image discovery logic
 * Finds and ranks OG images from various sources
 */

import * as cheerio from 'cheerio';
import type { OGImageSource } from '../types';
import type { AppConfig } from './config';
import { parseDataUrl, validateImage } from './image-processor';
import { isDataUrl } from './validators';
import { extractMetadata, type PageMetadata } from './metadata-extractor';

/**
 * Browser-like User-Agent for HTML parsing (sites often block bots for HTML)
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Find all possible OG image URLs for a given website
 */
export async function findOGImages(
  url: string,
  config: AppConfig
): Promise<OGImageSource[]> {
  const images: OGImageSource[] = [];

  // Ensure URL has protocol
  const targetUrl = url.startsWith('http') ? url : `https://${url}`;

  try {
    // Fetch HTML content and get final URL after redirects
    const { html, finalUrl } = await fetchHtml(targetUrl, config);
    const finalParsedUrl = new URL(finalUrl);
    const finalBaseUrl = `${finalParsedUrl.protocol}//${finalParsedUrl.hostname}`;
    const $ = cheerio.load(html);

    // Extract OG images from meta tags
    images.push(...extractFromOGTags($, finalBaseUrl));

    // Extract Twitter card images
    images.push(...extractFromTwitterTags($, finalBaseUrl));

    // Extract from JSON-LD schema
    images.push(...extractFromJsonLd($, finalBaseUrl));
  } catch (error) {
    // If HTML fetch fails, continue with empty results
  }

  // Sort by score (highest first) and return
  return images.sort((a, b) => b.score - a.score);
}

/**
 * Fetch HTML content from URL and return final URL after redirects
 * First attempts with honest USER_AGENT, falls back to BROWSER_USER_AGENT if needed
 */
async function fetchHtml(
  url: string,
  config: AppConfig
): Promise<{ html: string; finalUrl: string }> {
  // Try with honest USER_AGENT first
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': config.USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(config.REQUEST_TIMEOUT),
      redirect: 'follow',
    });

    if (response.ok) {
      const html = await response.text();
      const finalUrl = response.url;
      return { html, finalUrl };
    }
  } catch {
    // First attempt failed, will try with browser UA
  }

  // Fallback: Try with browser-like UA if honest UA failed
  const response = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(config.REQUEST_TIMEOUT),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  const finalUrl = response.url;

  return { html, finalUrl };
}

/**
 * Extract OG images from OpenGraph meta tags
 */
function extractFromOGTags($: cheerio.CheerioAPI, baseUrl: string): OGImageSource[] {
  const images: OGImageSource[] = [];
  const ogImages: Array<{
    url?: string;
    width?: string;
    height?: string;
    alt?: string;
    type?: string;
  }> = [];

  // Collect all og:image tags and their properties
  $('meta[property^="og:image"]').each((_, element) => {
    const property = $(element).attr('property');
    const content = $(element).attr('content');

    if (!property || !content) return;

    if (property === 'og:image' || property === 'og:image:url' || property === 'og:image:secure_url') {
      ogImages.push({ url: content });
    }
  });

  // For each image, try to find associated metadata
  $('meta[property^="og:image"]').each((index, element) => {
    const property = $(element).attr('property');
    const content = $(element).attr('content');

    if (!property || !content) return;

    const currentImage = ogImages[0]; // Most common: single image with metadata
    if (!currentImage) return;

    if (property === 'og:image:width' && currentImage) {
      currentImage.width = content;
    } else if (property === 'og:image:height' && currentImage) {
      currentImage.height = content;
    } else if (property === 'og:image:alt' && currentImage) {
      currentImage.alt = content;
    } else if (property === 'og:image:type' && currentImage) {
      currentImage.type = content;
    }
  });

  // Convert to OGImageSource format
  for (const ogImage of ogImages) {
    if (!ogImage.url) continue;

    const width = ogImage.width ? parseInt(ogImage.width, 10) : undefined;
    const height = ogImage.height ? parseInt(ogImage.height, 10) : undefined;

    images.push({
      url: resolveUrl(ogImage.url, baseUrl),
      width,
      height,
      alt: ogImage.alt,
      type: ogImage.type,
      source: 'og:image',
      score: calculateScore(width, height, 'og:image', ogImage.type),
    });
  }

  return images;
}

/**
 * Extract images from Twitter card meta tags
 */
function extractFromTwitterTags($: cheerio.CheerioAPI, baseUrl: string): OGImageSource[] {
  const images: OGImageSource[] = [];

  const twitterImage = $('meta[name="twitter:image"]').attr('content');
  const twitterImageAlt = $('meta[name="twitter:image:alt"]').attr('content');

  if (twitterImage) {
    images.push({
      url: resolveUrl(twitterImage, baseUrl),
      alt: twitterImageAlt,
      source: 'twitter:image',
      score: calculateScore(undefined, undefined, 'twitter:image'),
    });
  }

  return images;
}

/**
 * Extract images from JSON-LD schema
 */
function extractFromJsonLd($: cheerio.CheerioAPI, baseUrl: string): OGImageSource[] {
  const images: OGImageSource[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const jsonText = $(element).html();
      if (!jsonText) return;

      const schema = JSON.parse(jsonText);

      // Handle array of schemas
      const schemas = Array.isArray(schema) ? schema : [schema];

      for (const schemaItem of schemas) {
        // Check for image property
        if (schemaItem.image) {
          const imageUrls = Array.isArray(schemaItem.image)
            ? schemaItem.image
            : [schemaItem.image];

          for (const imageUrl of imageUrls) {
            // Image can be a string URL or an object
            const url = typeof imageUrl === 'string' ? imageUrl : imageUrl.url;
            const width = typeof imageUrl === 'object' ? imageUrl.width : undefined;
            const height = typeof imageUrl === 'object' ? imageUrl.height : undefined;

            if (url) {
              images.push({
                url: resolveUrl(url, baseUrl),
                width: width ? parseInt(String(width), 10) : undefined,
                height: height ? parseInt(String(height), 10) : undefined,
                source: 'schema.org',
                score: calculateScore(width, height, 'schema.org'),
              });
            }
          }
        }
      }
    } catch {
      // Invalid JSON-LD, skip
    }
  });

  return images;
}

/**
 * Calculate quality score for an OG image
 */
function calculateScore(
  width: number | undefined,
  height: number | undefined,
  source: string,
  type?: string
): number {
  let score = 50;

  // Source preference (OpenGraph > Twitter > Schema.org)
  if (source === 'og:image') score += 100;
  else if (source === 'twitter:image') score += 80;
  else if (source === 'schema.org') score += 60;

  // Size preference (larger is generally better for OG images)
  // OG images are typically 1200x630 or similar
  if (width && height) {
    const area = width * height;

    if (area >= 1200 * 630) score += 90; // Full OG size or larger
    else if (area >= 800 * 600) score += 80;
    else if (area >= 600 * 400) score += 70;
    else if (area >= 400 * 300) score += 60;
    else if (area >= 300 * 200) score += 50;
  } else if (width || height) {
    // Partial size info
    const dimension = width || height || 0;
    if (dimension >= 1200) score += 70;
    else if (dimension >= 800) score += 60;
    else if (dimension >= 600) score += 50;
  }

  // Format preference
  if (type?.includes('png')) score += 20;
  else if (type?.includes('jpeg') || type?.includes('jpg')) score += 15;
  else if (type?.includes('webp')) score += 25;

  return score;
}

/**
 * Resolve relative URL to absolute
 */
function resolveUrl(url: string, baseUrl: string): string {
  // Handle data URLs (inline images)
  if (isDataUrl(url)) {
    return url;
  }

  if (url.startsWith('http')) {
    return url;
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  if (url.startsWith('/')) {
    return `${baseUrl}${url}`;
  }

  return `${baseUrl}/${url}`;
}

/**
 * Fetch the best OG image from the list
 */
export async function fetchBestOGImage(
  images: OGImageSource[],
  config: AppConfig
): Promise<{ data: Buffer; format: string; source: string; url: string; isFallback?: boolean } | null> {
  for (const image of images) {
    try {
      let buffer: Buffer;
      let mimeType: string | undefined;

      // Check if this is a data URL
      if (isDataUrl(image.url)) {
        const parsed = parseDataUrl(image.url);
        if (!parsed) continue;
        buffer = parsed.buffer;
        mimeType = parsed.mimeType;
      } else {
        // Regular HTTP(S) URL - fetch it
        const response = await fetch(image.url, {
          headers: {
            'User-Agent': config.USER_AGENT,
            Accept: 'image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(config.REQUEST_TIMEOUT),
        });

        if (!response.ok) continue;

        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
      }

      // Validate buffer size and that it contains valid image data
      if (buffer.length > 0 && buffer.length <= config.MAX_IMAGE_SIZE) {
        // Check if buffer contains valid image data before returning
        const isValid = await validateImage(buffer);
        if (isValid) {
          const format = detectFormat(buffer, mimeType || image.type);
          return {
            data: buffer,
            format,
            source: image.source,
            url: image.url,
            isFallback: image.isFallback
          };
        }
      }
    } catch {
      // Try next image
      continue;
    }
  }

  return null;
}

/**
 * Detect image format from buffer
 */
function detectFormat(buffer: Buffer, hint?: string): string {
  // Check magic numbers
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'webp';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
  if (buffer.toString('utf8', 0, 5).includes('<svg')) return 'svg';

  // Fallback to hint
  const hintStr = hint || '';
  if (hintStr.includes('png')) return 'png';
  if (hintStr.includes('jpeg') || hintStr.includes('jpg')) return 'jpg';
  if (hintStr.includes('webp')) return 'webp';
  if (hintStr.includes('svg')) return 'svg';
  if (hintStr.includes('gif')) return 'gif';

  return 'png'; // Default
}
