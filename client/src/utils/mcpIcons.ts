/**
 * Détection automatique du logo d'un serveur MCP (comme sur Claude).
 * Utilisé seulement quand le serveur n'a pas d'`iconPath` défini à la main.
 */

const BRAND_DOMAINS: Array<[RegExp, string]> = [
  [/github/i, 'github.com'],
  [/cloudflare/i, 'cloudflare.com'],
  [/supabase/i, 'supabase.com'],
  [/vercel/i, 'vercel.com'],
  [/\brender\b/i, 'render.com'],
  [/vuetify/i, 'vuetifyjs.com'],
  [/firebase/i, 'firebase.google.com'],
  [/stripe/i, 'stripe.com'],
  [/notion/i, 'notion.so'],
  [/slack/i, 'slack.com'],
  [/linear/i, 'linear.app'],
  [/sentry/i, 'sentry.io'],
  [/figma/i, 'figma.com'],
  [/atlassian|jira|confluence/i, 'atlassian.com'],
  [/asana/i, 'asana.com'],
  [/canva/i, 'canva.com'],
  [/zapier/i, 'zapier.com'],
  [/paypal/i, 'paypal.com'],
  [/hubspot/i, 'hubspot.com'],
  [/huggingface|hugging-face/i, 'huggingface.co'],
];

const DOMAIN_ALIASES: Record<string, string> = {
  'githubcopilot.com': 'github.com',
  'githubusercontent.com': 'github.com',
  'googleapis.com': 'google.com',
};

/** Hébergeurs génériques : leur logo ne représente pas le service. */
const GENERIC_HOSTS = [
  'workers.dev',
  'pages.dev',
  'vercel.app',
  'onrender.com',
  'herokuapp.com',
  'fly.dev',
  'netlify.app',
  'ngrok.io',
  'ngrok-free.app',
  'trycloudflare.com',
  'railway.app',
  'localhost',
];

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);

function registrableDomain(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (GENERIC_HOSTS.some((generic) => host === generic || host.endsWith(`.${generic}`))) {
    return null;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return null;
  }
  const parts = host.split('.');
  if (parts.length < 2) {
    return null;
  }
  const useThree = parts.length >= 3 && SECOND_LEVEL.has(parts[parts.length - 2]);
  const domain = parts.slice(useThree ? -3 : -2).join('.');
  return DOMAIN_ALIASES[domain] ?? domain;
}

function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function getMCPIconUrl(serverName: string, meta: any): string | null {
  const url: string = typeof meta?.url === 'string' ? meta.url : '';
  const title: string = typeof meta?.title === 'string' ? meta.title : '';
  const haystack = `${serverName} ${title} ${url}`;

  for (const [pattern, domain] of BRAND_DOMAINS) {
    if (pattern.test(haystack)) {
      return faviconUrl(domain);
    }
  }

  if (url) {
    try {
      const domain = registrableDomain(new URL(url).hostname);
      if (domain) {
        return faviconUrl(domain);
      }
    } catch {
      /* URL invalide : pas d'icône automatique */
    }
  }
  return null;
}

/** Ajoute `iconPath` aux serveurs qui n'en ont pas. */
export function withMCPIcons<T>(servers: T): T {
  if (!servers || typeof servers !== 'object') {
    return servers;
  }
  const next: Record<string, any> = {};
  for (const [name, meta] of Object.entries(servers as Record<string, any>)) {
    if (!meta || typeof meta !== 'object' || meta.iconPath) {
      next[name] = meta;
      continue;
    }
    const icon = getMCPIconUrl(name, meta);
    next[name] = icon ? { ...meta, iconPath: icon } : meta;
  }
  return next as T;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
