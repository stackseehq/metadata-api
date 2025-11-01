# Favicon & OpenGraph API

[![CI](https://github.com/vemetric/favicon-api/actions/workflows/ci.yml/badge.svg)](https://github.com/vemetric/favicon-api/actions/workflows/ci.yml)

A free & self-hostable API service for fetching favicons and OpenGraph images. Built with TypeScript, Hono, and Bun. Get website favicons and social media preview images with multiple format options, intelligent fallbacks, and proper HTTP caching.

**Powered by [Vemetric](https://vemetric.com)**

## Features

- **Fast & Lightweight**: Built on Bun runtime and Hono framework
- **Smart Discovery**: Automatically finds the best favicon and OG images from multiple sources
- **OpenGraph Support**: Extract og:image, twitter:image, and schema.org images with metadata
- **Fallback API**: Optional fallback to Google's favicon API when primary fetch fails due to bot protection (enabled by default)
- **Format Support**: PNG, JPG, ICO, WebP, SVG
- **Image Processing**: Resize and convert images on-the-fly
- **Metadata Extraction**: Get page titles, descriptions, and site names from OG tags
- **Caching Ready**: Sets proper HTTP cache headers for CDN/proxy integration
- **Docker Ready**: Easy deployment with Docker
- **Fully Typed**: Written in TypeScript with strict type checking

## Quick Start

### Local Development

```bash
# Install dependencies
bun install

# Start development server (with hot reload)
bun run dev

# The server will start on http://localhost:3000
```

### Using Docker

**Option 1: Use Pre-built Image from Docker Hub**

```bash
# Run with default settings
docker run -d \
  -p 3000:3000 \
  --name favicon-api \
  --restart unless-stopped \
  vemetric/favicon-api

# Or run with custom configuration
docker run -d \
  -p 3000:3000 \
  --name favicon-api \
  --restart unless-stopped \
  -e PORT=3000 \
  -e DEFAULT_IMAGE_URL=https://example.com/default-favicon.png \
  -e USE_FALLBACK_API=true \
  -e CACHE_CONTROL_SUCCESS=604800 \
  -e CACHE_CONTROL_ERROR=604800 \
  -e REQUEST_TIMEOUT=5000 \
  -e MAX_IMAGE_SIZE=5242880 \
  -e ALLOWED_ORIGINS=* \
  -e BLOCK_PRIVATE_IPS=true \
  vemetric/favicon-api

# Check it's running
curl http://localhost:3000/health
```

**Option 2: Build from Source**

```bash
# Build the image
docker build -t favicon-api .

# Run the locally built image
docker run -d \
  -p 3000:3000 \
  --name favicon-api \
  --restart unless-stopped \
  favicon-api
```

## API Usage

### Favicon Endpoint

```
GET /<domain>?response=<json|image>&size=<number>&format=<png|jpg|webp>&default=<url>
```

#### Query Parameters

- `size` (optional): Desired image size in pixels (16-512)
- `format` (optional): Image output format - `png`, `jpg`, `webp`
- `response` (optional): Response format - `image` (default) or `json`
- `default` (optional): Fallback image URL (overrides server config)

#### Examples

**Get favicon as image:**

```bash
curl "http://localhost:3000/github.com"
```

**Get favicon and OG image metadata as JSON:**

```bash
curl "http://localhost:3000/github.com?response=json"
```

Returns both favicon and OpenGraph image in a single response:

```json
{
  "favicon": {
    "url": "http://localhost:3000/github.com",
    "sourceUrl": "https://github.githubassets.com/favicons/favicon.png",
    "width": 64,
    "height": 64,
    "format": "png",
    "bytes": 1234,
    "source": "link-tag"
  },
  "ogImage": {
    "url": "http://localhost:3000/og/github.com",
    "sourceUrl": "https://github.com/images/modules/open_graph/github-logo.png",
    "width": 1200,
    "height": 630,
    "format": "png",
    "bytes": 45678,
    "source": "og:image"
  },
  "metadata": {
    "title": "GitHub: Let's build from here",
    "description": "GitHub is where over 100 million developers shape the future of software",
    "siteName": "GitHub"
  }
}
```

**Field Descriptions:**
- `favicon` / `ogImage`: Image information objects
  - `url`: API URL to fetch this exact processed image
  - `sourceUrl`: Original image URL from the website
  - `width`, `height`: Image dimensions
  - `format`: Image format (png, jpg, webp, etc.)
  - `bytes`: File size in bytes
  - `source`: Source of the image (link-tag, manifest, og:image, twitter:image, etc.)
- `metadata`: Page metadata
  - `title`: Page title from og:title, twitter:title, or `<title>` tag
  - `description`: Page description from meta tags
  - `siteName`: Site name from og:site_name

**Note:** `ogImage` may be `null` if no OpenGraph image is found on the page.

**Resize favicon to 64x64:**

```bash
curl "http://localhost:3000/github.com?size=64"
```

**Convert to PNG:**

```bash
curl "http://localhost:3000/github.com?format=png&size=128"
```

**With custom fallback:**

```bash
curl "http://localhost:3000/example.com?default=https://mysite.com/fallback.png"
```

### OpenGraph Image Endpoint (Direct Access)

```
GET /og/<domain>?response=<json|image>&size=<number>&format=<png|jpg|webp>&default=<url>
```

The `/og/` endpoint provides **direct access** to OpenGraph images when you specifically need the OG image rather than the favicon.

**When to use `/og/` instead of `/`:**
- When you explicitly want the OpenGraph/social preview image
- When embedding social media previews in your UI
- When you need larger promotional images (typically 1200x630)

**When to use `/` (main endpoint):**
- When you want both favicon and OG image data (`?response=json`)
- When you just need the favicon for display
- When you want metadata along with images

#### Query Parameters

Same as favicon endpoint:
- `size` (optional): Desired image size in pixels (16-512)
- `format` (optional): Image output format - `png`, `jpg`, `webp`
- `response` (optional): Response format - `image` (default) or `json`
- `default` (optional): Fallback image URL (overrides server config)

#### Examples

**Get OpenGraph image directly:**

```bash
curl "http://localhost:3000/og/github.com"
```

**Use in HTML for social preview:**

```html
<img src="http://localhost:3000/og/github.com?size=600" alt="GitHub preview">
```

**Resize and convert OG image:**

```bash
curl "http://localhost:3000/og/github.com?size=800&format=webp"
```

## Configuration

Create a `.env` file (see `.env.example`):

## Architecture

The application is a **stateless processor** with no built-in caching. It:

1. Processes requests and finds favicons
2. Sets proper HTTP cache headers
3. Returns images or JSON responses

For production, add a **caching layer** in front (CDN or reverse proxy):

- **Cloudflare** (free tier)
- **BunnyCDN, KeyCDN** (paid)
- **Nginx/Caddy** (self-hosted)

## Development

```bash
# Install dependencies
bun install

# Run development server (with hot reload)
bun run dev

# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Type check
bun run typecheck

# Lint
bun run lint

# Format code
bun run format
```

## Deployment

### Option 1: Docker (Recommended)

**Using Pre-built Image:**

```bash
# Pull and run from Docker Hub
docker run -d \
  -p 3000:3000 \
  --name favicon-api \
  --restart unless-stopped \
  vemetric/favicon-api

# Verify it's running
curl http://your-server-ip:3000/health
```

**Building from Source:**

```bash
git clone https://github.com/vemetric/favicon-api.git
cd favicon-api

# Build and run
docker build -t favicon-api .
docker run -d \
  -p 3000:3000 \
  --name favicon-api \
  --restart unless-stopped \
  favicon-api

# Verify it's running
curl http://your-server-ip:3000/health
```

### Option 2: Direct with Bun (No Docker)

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Clone and run
git clone your-repo
cd favicon-api
bun install
bun run start
```

### With CDN (Recommended for Production)

**Cloudflare Setup:**

1. Add domain to Cloudflare
2. Point A record to your server IP
3. Enable "Proxy" mode (orange cloud)
4. Configure cache rules to respect origin headers

**BunnyCDN Setup:**

1. Create pull zone pointing to your origin
2. Enable "Respect Cache Headers"
3. Point CNAME to CDN hostname

## Image Sources

### Favicon Sources

The API searches multiple sources for favicons:

1. `<link rel="icon">` tags
2. `<link rel="apple-touch-icon">` tags
3. Web manifest files (`manifest.json`)
4. Common fallback locations (`/favicon.ico`, `/apple-touch-icon.png`)
5. **Google's favicon API** (optional fallback when primary sources fail due to bot protection or other issues)

Favicons are ranked by quality (size, format, source) and the best one is returned.

### OpenGraph Image Sources

The OG image endpoint searches for social media preview images from:

1. **OpenGraph meta tags** (`og:image`, `og:image:url`, `og:image:secure_url`)
2. **Twitter card tags** (`twitter:image`)
3. **Schema.org JSON-LD** (structured data with image properties)

Images are ranked by:
- Source priority (OpenGraph > Twitter > Schema.org)
- Image size (larger images score higher)
- Format quality (WebP > PNG > JPG)

### Fallback Strategy

When the primary favicon fetch fails (e.g., due to bot protection), the API can optionally fall back to Google's favicon service:

1. **Primary fetch**: Attempts to fetch favicon from the website's own sources
2. **Fallback API** (if enabled via `USE_FALLBACK_API=true`): Queries Google's favicon API
3. **Default image**: Returns the configured default fallback image (or 404 if not configured)

The Google API fallback is enabled by default and provides reliable results even for sites with strict bot protection. To disable it, set `USE_FALLBACK_API=false` in your environment configuration.

## Used by

The following projects are using the Favicon API:

- [Vemetric](https://vemetric.com) - Simple, yet actionable Web & Product Analytics
- [Orshot](https://orshot.com/) - Scale your Marketing with Automated Visuals
- [OpenPanel](https://openpanel.com?utm_src=vemetric_readme) - Next Generation Web Hosting Panel

Are you using the Favicon API and wanna be listed here? Feel free to file a Pull Request!

## Credits

This project was mainly coded using [Claude Code](https://www.claude.com/product/claude-code). We're also using the following libraries:

- [Bun](https://bun.sh) - Fast JavaScript runtime
- [Hono](https://hono.dev) - Lightweight web framework
- [Sharp](https://sharp.pixelplumbing.com) - Image processing
- [Cheerio](https://cheerio.js.org) - HTML parsing
