const TRACKING_PARAMETERS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',

  'gclid',
  'fbclid',
  'msclkid',

  'mc_cid',
  'mc_eid',

  '_ga',
  '_gl',
]);

const BLOCKED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.ico',

  '.mp3',
  '.wav',
  '.ogg',
  '.flac',

  '.mp4',
  '.webm',
  '.avi',
  '.mov',

  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',

  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',

  '.exe',
  '.msi',
  '.dmg',
  '.iso',
]);

const BLOCKED_PATHS = [
  '/wp-admin/',
  '/wp-login.php',
];

const BLOCKED_SCHEMES = [
  'mailto:',
  'tel:',
  'javascript:',
  'data:',
  'blob:',
  'file:',
];

export function normaliseUrl(rawUrl, baseUrl = null) {
  if (
    typeof rawUrl !== 'string' ||
    !rawUrl.trim()
  ) {
    return null;
  }

  const value = rawUrl.trim();

  if (
    BLOCKED_SCHEMES.some(scheme =>
      value.toLowerCase().startsWith(scheme)
    )
  ) {
    return null;
  }

  let url;

  try {
    url = new URL(value, baseUrl || undefined);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:'
  ) {
    return null;
  }

  // Fragments don't identify separate documents.
  url.hash = '';

  // Remove tracking parameters.
  for (const parameter of [...url.searchParams.keys()]) {
    if (
      TRACKING_PARAMETERS.has(
        parameter.toLowerCase()
      )
    ) {
      url.searchParams.delete(parameter);
    }
  }

  /*
   * Normalise the hostname.
   * DNS hostnames are case-insensitive.
   */
  url.hostname = url.hostname.toLowerCase();

  /*
   * The default ports don't add anything.
   */
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  return url.href;
}

export function shouldCrawl(url) {
  if (!url) {
    return false;
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:'
  ) {
    return false;
  }

  const pathname =
    parsed.pathname.toLowerCase();

  if (
    BLOCKED_PATHS.some(path =>
      pathname.startsWith(path)
    )
  ) {
    return false;
  }

  for (const extension of BLOCKED_EXTENSIONS) {
    if (pathname.endsWith(extension)) {
      return false;
    }
  }

  return true;
}

export function prepareUrl(rawUrl, baseUrl = null) {
  const url = normaliseUrl(
    rawUrl,
    baseUrl
  );

  if (!url) {
    return null;
  }

  if (!shouldCrawl(url)) {
    return null;
  }

  return url;
}