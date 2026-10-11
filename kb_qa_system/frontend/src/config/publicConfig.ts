export interface PublicConfig {
  contactEmail?: string;
  operatorName?: string;
  operatorLocation?: string;
  processingRegion?: string;
  retentionNotice?: string;
  crossBorderNotice?: string;
  thirdPartyNotice?: string;
}

declare global {
  interface Window {
    __KB_PUBLIC_CONFIG__?: PublicConfig;
  }
}

const EMAIL_PATTERN = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

export function getPublicConfig(): PublicConfig {
  return window.__KB_PUBLIC_CONFIG__ ?? {};
}

export function getPublicContactEmail(): string | undefined {
  const email = getPublicConfig().contactEmail?.trim();
  return email && EMAIL_PATTERN.test(email) ? email : undefined;
}
