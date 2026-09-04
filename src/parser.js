const BLOCKED_SCHEMES = new Set([
  'mailto:',
  'tel:',
  'javascript:',
  'data:',
  'blob:',
  'file:',
]);

const SKIP_ELEMENTS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
]);

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      try {
        return String.fromCodePoint(parseInt(code, 16));
      } catch {
        return '';
      }
    });
}

function cleanText(text) {
  return decodeHtmlEntities(text)
    .replace(/<[^>]+>/g, ' ')  // Strip HTML tags
    .replace(/\s+/g, ' ')       // Normalize whitespace
    .trim();
}

function getAttribute(tag, name) {
  const regex = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`,
    'i'
  );

  const match = tag.match(regex);

  if (!match) {
    return null;
  }

  return match[1] ?? match[2] ?? match[3] ?? null;
}

function getMetaDescription(html) {
  const metaRegex = /<meta\b[^>]*>/gi;
  const tags = html.match(metaRegex) || [];

  for (const tag of tags) {
    const name = getAttribute(tag, 'name');

    if (!name || name.toLowerCase() !== 'description') {
      continue;
    }

    const content = getAttribute(tag, 'content');

    if (content) {
      return cleanText(content);
    }
  }

  return null;
}

function getTitle(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);

  if (!match) {
    return '';
  }

  return cleanText(match[1]);
}

function getFirstParagraph(html) {
  const paragraphRegex = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi;

  let match;

  while ((match = paragraphRegex.exec(html)) !== null) {
    const text = cleanText(
      match[1]
        .replace(/<[^>]+>/g, ' ')
    );

    // Ignore tiny/useless paragraphs.
    if (text.length >= 30) {
      return text;
    }
  }

  return '';
}

function extractLinks(html, baseUrl) {
  const links = new Set();

  const linkRegex = /<a\b[^>]*>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = getAttribute(match[0], 'href');

    if (!href) {
      continue;
    }

    const trimmed = href.trim();

    if (!trimmed) {
      continue;
    }

    const lower = trimmed.toLowerCase();

    // Skip fragments and non-web schemes.
    if (
      lower.startsWith('#') ||
      [...BLOCKED_SCHEMES].some(scheme => lower.startsWith(scheme))
    ) {
      continue;
    }

    try {
      const url = new URL(trimmed, baseUrl);

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        continue;
      }

      // Fragments don't represent different pages.
      url.hash = '';

      links.add(url.href);
    } catch {
      // Invalid URLs are simply ignored.
    }
  }

  return [...links];
}

function removeNonContent(html) {
  return html.replace(
    /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' '
  );
}

export function parsePage(html, url) {
  if (typeof html !== 'string') {
    throw new TypeError('HTML must be a string');
  }

  if (typeof url !== 'string') {
    throw new TypeError('URL must be a string');
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (
    parsedUrl.protocol !== 'http:' &&
    parsedUrl.protocol !== 'https:'
  ) {
    throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
  }

  const title = getTitle(html);

  let description = getMetaDescription(html);
  const hasMetaDescription = !!description;

  if (!description) {
    description = getFirstParagraph(removeNonContent(html));
  }

  // Limit title and description length to prevent huge storage
  const MAX_TITLE_LENGTH = 200;
  const MAX_DESCRIPTION_LENGTH = 500;

  let truncatedTitle = title;
  let truncatedDescription = description;

  if (truncatedTitle.length > MAX_TITLE_LENGTH) {
    truncatedTitle = truncatedTitle.substring(0, MAX_TITLE_LENGTH - 3) + '...';
  }

  if (truncatedDescription.length > MAX_DESCRIPTION_LENGTH) {
    truncatedDescription = truncatedDescription.substring(0, MAX_DESCRIPTION_LENGTH - 3) + '...';
  }

  return {
    url: parsedUrl.href,
    title: truncatedTitle,
    description: truncatedDescription,
    hasMetaDescription,  // Flag to indicate if description came from meta tag
    links: extractLinks(html, parsedUrl.href),
  };
}