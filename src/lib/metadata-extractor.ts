/**
 * Shared metadata extraction logic
 * Extracts page metadata from HTML (title, description, site name)
 */

import type * as cheerio from 'cheerio';

export interface PageMetadata {
  title?: string;
  description?: string;
  siteName?: string;
}

/**
 * Extract metadata from parsed HTML
 */
export function extractMetadata($: cheerio.CheerioAPI): PageMetadata {
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').text();

  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') ||
    $('meta[name="description"]').attr('content');

  const siteName = $('meta[property="og:site_name"]').attr('content');

  return {
    title,
    description,
    siteName,
  };
}
