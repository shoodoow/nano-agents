/**
 * Every environment setting the core reads, in one place.
 * Why: settings used to be read wherever they were needed, each with its own
 * default, so one module could fall back to a built-in secret while another
 * refused to start. Values are read on each call, not frozen at import, so a
 * test can change one and see the change.
 */

const LOCAL_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const LOCAL_PUBLIC_URL = "http://127.0.0.1:3000";
const MIN_SECRET_LENGTH = 32;

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function list(name: string): string[] {
  return (read(name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  isProduction: (): boolean => process.env.NODE_ENV === "production",
  isTest: (): boolean => process.env.NODE_ENV === "test",

  databaseUrl: (): string => read("DATABASE_URL") ?? LOCAL_DATABASE_URL,
  host: (): string => read("HOST") ?? "127.0.0.1",
  port: (): number => Number(read("PORT") ?? 3000),
  /**
   * Whose X-Forwarded-For header the core believes, as Express "trust proxy".
   * Why: a tunnel or reverse proxy on this machine connects from loopback and
   * names the real client in that header. Believing it only from loopback
   * gives each client its own request limit with nothing to configure, while
   * a client connecting directly cannot claim to be someone else.
   * TRUST_PROXY=1 trusts one proxy on another host; TRUST_PROXY=0 trusts none.
   */
  trustProxy: (): number | string | false => {
    const value = read("TRUST_PROXY");
    if (value === "0" || value === "false") return false;
    if (value && /^\d+$/.test(value)) return Number(value);
    return value ?? "loopback";
  },
  logLevel: (): string => read("LOG_LEVEL") ?? (config.isTest() ? "silent" : "info"),

  /** The public origin phones and OAuth providers reach the core on. */
  publicUrl: (): string => read("BETTER_AUTH_URL") ?? LOCAL_PUBLIC_URL,
  trustedOrigins: (): string[] => list("BETTER_AUTH_TRUSTED_ORIGINS"),

  /**
   * The secret that signs sessions and derives the vault key.
   * There is no built-in value: a core started without one stops here, in
   * every environment, so stored keys are never sealed with a public constant.
   */
  authSecret: (): string => {
    const secret = read("BETTER_AUTH_SECRET");
    if (!secret) {
      throw new Error("BETTER_AUTH_SECRET is required. Generate one with: openssl rand -hex 32");
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
    }
    return secret;
  },

  googleClientId: (): string | undefined => read("GOOGLE_CLIENT_ID"),
  googleClientSecret: (): string | undefined => read("GOOGLE_CLIENT_SECRET"),

  skillsDir: (): string | undefined => read("SKILLS_DIR"),
  dockerSocket: (): string => read("DOCKER_SOCKET") ?? "/var/run/docker.sock",

  braveApiKey: (): string | undefined => read("BRAVE_API_KEY"),
  exaApiKey: (): string | undefined => read("EXA_API_KEY"),
  embeddingProvider: (): string => read("EMBEDDING_PROVIDER") ?? "openai",
  embeddingModel: (): string | undefined => read("EMBEDDING_MODEL"),
};
