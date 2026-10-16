// Test stub for Astro's virtual `astro:env/server` module. Only `getSecret`
// (and `getEnv`) are used by the app; both just read `process.env` so unit
// tests can control credential resolution without booting Astro.

export function getSecret(name: string): string | undefined {
  return process.env[name];
}

export function getEnv(name: string): string | undefined {
  return process.env[name];
}
