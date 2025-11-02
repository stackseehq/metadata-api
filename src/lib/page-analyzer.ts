/**
 * Page analyzer - fetches HTML once and extracts all metadata, favicons, and OG images
 * This eliminates duplicate HTML fetching and metadata extraction
 */

import * as cheerio from 'cheerio';
import type { FaviconSource, OGImageSource } from '../types';
import type { AppConfig } from './config';
import { extractMetadata, type PageMetadata } from './metadata-extractor';
import { isDataUrl } from './validators';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface PageAnalysisResult {
  favicons: FaviconSource[];
  ogImages: OGImageSource[];
  metadata: PageMetadata;
}

/**
 * Analyze a page and extract all relevant data in a single pass
 */
export async function analyzePage(
  url: string,
  config: AppConfig,
  size?: number
): Promise<PageAnalysisResult> {
  const favicons: FaviconSource[] = [];
  const ogImages: OGImageSource[] = [];
  let metadata: PageMetadata = {};

  // Ensure URL has protocol
  const targetUrl = url.startsWith('http') ? url : `https://${url}`;

  try {
    // Fetch HTML content and get final URL after redirects
    const { html, finalUrl } = await fetchHtml(targetUrl, config);
    const finalParsedUrl = new URL(finalUrl);
    const finalBaseUrl = `${finalParsedUrl.protocol}//${finalParsedUrl.hostname}`;
    const $ = cheerio.load(html);

    // Extract metadata (single pass)
    metadata = extractMetadata($);

    // Extract favicons
    favicons.push(...extractFaviconFromLinkTags($, finalBaseUrl));

    // Add common fallback locations
    favicons.push({
      url: `${finalBaseUrl}/favicon.ico`,
      source: 'fallback',
      score: 10,
    });

    favicons.push({
      url: `${finalBaseUrl}/apple-touch-icon.png`,
      source: 'fallback',
      score: 20,
    });

    // Try to fetch and parse manifest.json
    const manifestFavicons = await extractFaviconFromManifest(finalBaseUrl, config);
    favicons.push(...manifestFavicons);

    // Extract OG images
    ogImages.push(...extractOGFromTags($, finalBaseUrl));
    ogImages.push(...extractOGFromTwitterTags($, finalBaseUrl));
    ogImages.push(...extractOGFromJsonLd($, finalBaseUrl));
  } catch {
    // If HTML fetch fails, continue with empty results
  }

  // Add Google's favicon API as last-resort fallback (if enabled)
  if (config.USE_FALLBACK_API) {
    const trimmedDomain = url.trim();
    const parsedUrl = new URL(
      trimmedDomain.startsWith('http') ? trimmedDomain : `https://${trimmedDomain}`
    );
    const formattedDomain = `https://${parsedUrl.hostname}`;

    favicons.push({
      url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(formattedDomain)}&sz=${size || 64}`,
      source: 'fallback-api',
      score: 1,
      isFallback: true,
    });
  }

  return {
    favicons: favicons.sort((a, b) => b.score - a.score),
    ogImages: ogImages.sort((a, b) => b.score - a.score),
    metadata,
  };
}

/**
 * Fetch HTML content from URL
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

  // Fallback: Try with browser-like UA
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
 * Extract favicon URLs from link tags
 */
function extractFaviconFromLinkTags($: cheerio.CheerioAPI, baseUrl: string): FaviconSource[] {
  const favicons: FaviconSource[] = [];

  $('link[rel*="icon"]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;

    const sizes = $(element).attr('sizes');
    let type = $(element).attr('type') || '';
    const rel = $(element).attr('rel') || '';

    if (!type) {
      if (isDataUrl(href)) {
        const mimeMatch = href.match(/^data:([^;,]+)/);
        if (mimeMatch && mimeMatch[1]) {
          type = mimeMatch[1];
        }
      } else {
        type = href.split('.').pop() || '';
      }
    }

    const size = parseSizes(sizes);
    const score = calculateFaviconScore(size, type, rel);

    favicons.push({
      url: resolveUrl(href, baseUrl),
      size,
      format: type,
      source: 'link-tag',
      score,
    });
  });

  return favicons;
}

/**
 * Extract favicons from web manifest
 */
async function extractFaviconFromManifest(baseUrl: string, config: AppConfig): Promise<FaviconSource[]> {
  const favicons: FaviconSource[] = [];

  try {
    const manifestUrl = `${baseUrl}/manifest.json`;
    const response = await fetch(manifestUrl, {
      headers: {
        'User-Agent': config.USER_AGENT,
      },
      signal: AbortSignal.timeout(config.REQUEST_TIMEOUT),
    });

    if (response.ok) {
      const manifest = await response.json() as { icons?: Array<{ src: string; sizes?: string; type?: string }> };
      if (manifest.icons && Array.isArray(manifest.icons)) {
        for (const icon of manifest.icons) {
          if (icon.src) {
            favicons.push({
              url: resolveUrl(icon.src, baseUrl),
              size: parseSizes(icon.sizes),
              format: icon.type,
              source: 'manifest',
              score: 40,
            });
          }
        }
      }
    }
  } catch {
    // Manifest not found or invalid
  }

  return favicons;
}

/**
 * Extract OG images from meta tags
 */
function extractOGFromTags($: cheerio.CheerioAPI, baseUrl: string): OGImageSource[] {
  const images: OGImageSource[] = [];
  const ogImages: Array<{
    url?: string;
    width?: string;
    height?: string;
    alt?: string;
    type?: string;
  }> = [];

  // Collect all og:image tags
  $('meta[property^="og:image"]').each((_, element) => {
    const property = $(element).attr('property');
    const content = $(element).attr('content');

    if (!property || !content) return;

    if (property === 'og:image' || property === 'og:image:url' || property === 'og:image:secure_url') {
      ogImages.push({ url: content });
    }
  });

  // Find associated metadata
  $('meta[property^="og:image"]').each((_, element) => {
    const property = $(element).attr('property');
    const content = $(element).attr('content');

    if (!property || !content) return;

    const currentImage = ogImages[0];
    if (!currentImage) return;

    if (property === 'og:image:width') {
      currentImage.width = content;
    } else if (property === 'og:image:height') {
      currentImage.height = content;
    } else if (property === 'og:image:alt') {
      currentImage.alt = content;
    } else if (property === 'og:image:type') {
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
      score: calculateOGScore(width, height, 'og:image', ogImage.type),
      isFallback: false,
    });
  }

  return images;
}

/**
 * Extract images from Twitter card tags
 */
function extractOGFromTwitterTags($: cheerio.CheerioAPI, baseUrl: string): OGImageSource[] {
  const images: OGImageSource[] = [];

  const twitterImage = $('meta[name="twitter:image"]').attr('content');
  const twitterImageAlt = $('meta[name="twitter:image:alt"]').attr('content');

  if (twitterImage) {
    images.push({
      url: resolveUrl(twitterImage, baseUrl),
      alt: twitterImageAlt,
      source: 'twitter:image',
      score: calculateOGScore(undefined, undefined, 'twitter:image'),
      isFallback: false,
    });
  }

  return images;
}

/**
 * Extract images from JSON-LD schema
 */
function extractOGFromJsonLd($: cheerio.CheerioAPI, baseUrl: string): OGImageSource[] {
  const images: OGImageSource[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const jsonText = $(element).html();
      if (!jsonText) return;

      const schema = JSON.parse(jsonText);
      const schemas = Array.isArray(schema) ? schema : [schema];

      for (const schemaItem of schemas) {
        if (schemaItem.image) {
          const imageUrls = Array.isArray(schemaItem.image)
            ? schemaItem.image
            : [schemaItem.image];

          for (const imageUrl of imageUrls) {
            const url = typeof imageUrl === 'string' ? imageUrl : imageUrl.url;
            const width = typeof imageUrl === 'object' ? imageUrl.width : undefined;
            const height = typeof imageUrl === 'object' ? imageUrl.height : undefined;

            if (url) {
              images.push({
                url: resolveUrl(url, baseUrl),
                width: width ? parseInt(String(width), 10) : undefined,
                height: height ? parseInt(String(height), 10) : undefined,
                source: 'schema.org',
                score: calculateOGScore(width, height, 'schema.org'),
                isFallback: false,
              });
            }
          }
        }
      }
    } catch {
      // Invalid JSON-LD
    }
  });

  return images;
}

/**
 * Utility functions
 */
function parseSizes(sizes: string | undefined): number | undefined {
  if (!sizes) return undefined;
  const match = sizes.match(/(\d+)x\d+/);
  return match && match[1] ? parseInt(match[1], 10) : undefined;
}

function calculateFaviconScore(size: number | undefined, type: string | undefined, rel: string): number {
  let score = 50;

  if (type?.includes('svg')) score += 100;

  if (size) {
    if (size >= 512) score += 90;
    else if (size >= 256) score += 80;
    else if (size >= 192) score += 70;
    else if (size >= 128) score += 60;
    else if (size >= 64) score += 50;
    else if (size >= 32) score += 40;
  }

  if (type?.includes('png')) score += 20;
  else if (type?.includes('webp')) score += 15;
  else if (type?.includes('gif')) score += 10;
  else if (type?.includes('ico')) score += 5;

  if (rel.includes('apple-touch-icon')) score += 10;
  if (rel.includes('mask-icon')) score -= 10;

  return score;
}

function calculateOGScore(
  width: number | undefined,
  height: number | undefined,
  source: string,
  type?: string
): number {
  let score = 50;

  if (source === 'og:image') score += 100;
  else if (source === 'twitter:image') score += 80;
  else if (source === 'schema.org') score += 60;

  if (width && height) {
    const area = width * height;
    if (area >= 1200 * 630) score += 90;
    else if (area >= 800 * 600) score += 80;
    else if (area >= 600 * 400) score += 70;
    else if (area >= 400 * 300) score += 60;
    else if (area >= 300 * 200) score += 50;
  } else if (width || height) {
    const dimension = width || height || 0;
    if (dimension >= 1200) score += 70;
    else if (dimension >= 800) score += 60;
    else if (dimension >= 600) score += 50;
  }

  if (type?.includes('png')) score += 20;
  else if (type?.includes('jpeg') || type?.includes('jpg')) score += 15;
  else if (type?.includes('webp')) score += 25;

  return score;
}

function resolveUrl(url: string, baseUrl: string): string {
  if (isDataUrl(url)) return url;
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${baseUrl}${url}`;
  return `${baseUrl}/${url}`;
}
