const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, '');
const apiBaseUrl = configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:4000' : '');

export function apiUrl(path: string): string {
  if (!apiBaseUrl) {
    throw new Error('Servidor não configurado. Defina VITE_API_URL com a URL pública do backend.');
  }

  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new Error('VITE_API_URL precisa ser uma URL válida do backend.');
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || (!import.meta.env.DEV && (parsed.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(parsed.hostname)))
  ) {
    throw new Error('Em produção, VITE_API_URL deve apontar para a URL HTTPS pública do backend.');
  }

  return `${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
