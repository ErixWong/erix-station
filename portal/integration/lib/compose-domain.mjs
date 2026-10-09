export const BASE_DOMAIN = process.env.BASE_DOMAIN || 'localhost';
export const PORTAL_HOST = process.env.PORTAL_HOST || `station.${BASE_DOMAIN}`;
export const LLM_HOST = `llm.${BASE_DOMAIN}`;

export function composeDomainEnv(webPort = process.env.TRAEFIK_WEB_PORT || '8090') {
  return {
    BASE_DOMAIN,
    PORTAL_HOST,
    PORTAL_INTERNAL_HOSTS: process.env.PORTAL_INTERNAL_HOSTS || PORTAL_HOST,
    LLM_HOST,
    PORTAL_PUBLIC_BASE_URL: process.env.PORTAL_PUBLIC_BASE_URL || `http://${PORTAL_HOST}:${webPort}`,
    LLM_PUBLIC_BASE_URL: process.env.LLM_PUBLIC_BASE_URL || `http://${LLM_HOST}:${webPort}`,
  };
}
