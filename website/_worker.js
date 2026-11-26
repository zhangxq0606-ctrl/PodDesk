const REPO = 'zhangxq0606-ctrl/PodDesk';
const DL_RE = /^\/dl\/(v\d+\.\d+\.\d+)\/(PodDesk_(\d+\.\d+\.\d+)_(?:x64-setup\.exe|aarch64\.dmg)|SHA256SUMS\.txt)$/;

function contentTypeFor(file) {
  if (file === 'SHA256SUMS.txt') return 'text/plain; charset=utf-8';
  if (file.endsWith('.dmg')) return 'application/x-apple-diskimage';
  return 'application/octet-stream';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/dl/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const match = url.pathname.match(DL_RE);
    if (!match) {
      return new Response('Not Found', { status: 404 });
    }

    const [, tag, file, fileVer] = match;
    if (fileVer && `v${fileVer}` !== tag) {
      return new Response('Not Found', { status: 404 });
    }

    const upstreamUrl = `https://github.com/${REPO}/releases/download/${tag}/${file}`;
    const reqHeaders = new Headers({
      'User-Agent': 'PodDesk-Website-Download/1.0',
    });
    const range = request.headers.get('range');
    if (range) reqHeaders.set('Range', range);

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers: reqHeaders,
        redirect: 'follow',
        cf: {
          cacheEverything: !range,
          cacheTtlByStatus: { '200-299': 86400, '404': 60 },
        },
      });
    } catch {
      return new Response('Upstream fetch failed', {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (!upstream.ok && upstream.status !== 206) {
      return new Response(
        upstream.status === 404 ? 'Release asset not found or not published yet' : 'Upstream error',
        {
          status: upstream.status === 404 ? 404 : 502,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }

    const resHeaders = new Headers();
    for (const key of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const val = upstream.headers.get(key);
      if (val) resHeaders.set(key, val);
    }
    resHeaders.set('Content-Type', contentTypeFor(file));
    resHeaders.set('Content-Disposition', `attachment; filename="${file}"`);
    resHeaders.set('Cache-Control', 'public, max-age=86400');
    resHeaders.set('X-PodDesk-Source', 'cf-pages-dl');

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });
  },
};
