import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "viem";

/**
 * Minimal signer surface needed for SIWE — implemented by LocalWalletSigner.
 * Kept structural so the opensea package doesn't depend on @aco/wallet.
 */
export interface SiweSigner {
  readonly address: Address;
  signMessage(message: string): Promise<string>;
}

interface LoggerLike {
  debug(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

const DEFAULT_STATEMENT =
  "Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).";
const SESSION_COOKIES = ["access_token", "refresh_token"];
const JWT_REFRESH_BUFFER_MS = 60_000;
const DEFAULT_JWT_TTL_S = 3600;
const PAT_EXPIRY_DAYS = 7;

interface ScopedToken {
  id: string;
  token: string;
  scopes: string[];
}

interface JwtEntry {
  token: string;
  expiresAt: number;
}

/**
 * Build the EIP-4361/SIWX message OpenSea's wallet-auth expects. The
 * `Ethereum ` account-type prefix in the first line is required — the verify
 * endpoint reconstructs and re-checks the signature against it.
 */
function buildSiweMessage(
  address: string,
  nonce: string,
  issuedAt: string,
  chainId = 1,
): string {
  return (
    `opensea.io wants you to sign in with your Ethereum account:\n` +
    `${address}\n\n` +
    `${DEFAULT_STATEMENT}\n\n` +
    `URI: https://opensea.io\n` +
    `Version: 1\n` +
    `Chain ID: ${chainId}\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  );
}

/** The parsed-message body the verify endpoint expects — must mirror the
 * signed message field-for-field (esp. issuedAt) or the signature check fails. */
function parsedMessage(
  address: string,
  nonce: string,
  issuedAt: string,
  chainId = 1,
) {
  return {
    domain: "opensea.io",
    address,
    statement: DEFAULT_STATEMENT,
    uri: "https://opensea.io",
    version: "1",
    chainId: String(chainId),
    nonce,
    issuedAt,
    accountType: "Ethereum",
  };
}

function extractSessionCookies(headers: Headers): string {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const raw = getSetCookie?.call(headers) ?? [];
  const cookies = new Map<string, string>();
  for (const c of raw) {
    const pair = c.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (SESSION_COOKIES.includes(name)) {
      cookies.set(name, pair.slice(eq + 1).trim());
    }
  }
  if (!cookies.has("access_token") || !cookies.has("refresh_token")) {
    throw new Error("SIWE verification did not return a session");
  }
  return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Manages OpenSea wallet-auth (SIWE) per wallet: runs the nonce → sign →
 * verify → PAT → JWT flow once, persists the long-lived PAT, and exchanges it
 * for short-lived JWTs on demand. The JWT is what unlocks wallet-scoped
 * endpoints like drop eligibility.
 */
export class WalletAuthManager {
  private readonly baseUrl: string;
  private readonly pats = new Map<string, string>();
  private readonly jwts = new Map<string, JwtEntry>();

  constructor(
    opts: {
      apiBaseUrl: string;
      /** File to persist scoped PATs (survives restarts). */
      persistPath?: string;
      logger?: LoggerLike;
    },
  ) {
    this.baseUrl = opts.apiBaseUrl.replace(/\/$/, "");
    this.logger = opts.logger;
    if (opts.persistPath) {
      this.persistPath = opts.persistPath;
      this.loadPats();
    }
  }

  private readonly persistPath?: string;
  private readonly logger?: LoggerLike;

  private loadPats(): void {
    try {
      if (this.persistPath && existsSync(this.persistPath)) {
        const raw = JSON.parse(readFileSync(this.persistPath, "utf8"));
        for (const [k, v] of Object.entries(raw ?? {})) {
          if (typeof v === "string") this.pats.set(k, v);
        }
      }
    } catch {
      // Corrupt PAT file — re-auth on demand.
    }
  }

  private savePats(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(
        this.persistPath,
        JSON.stringify(Object.fromEntries(this.pats), null, 2),
      );
    } catch {
      // best-effort
    }
  }

  /**
   * A valid JWT for `wallet`, or undefined when the wallet can't authenticate.
   * Order: cached JWT → exchange persisted PAT → full SIWE flow.
   */
  async getJwt(wallet: string, signer: SiweSigner): Promise<string | undefined> {
    const cached = this.jwts.get(wallet);
    if (cached && cached.expiresAt - Date.now() > JWT_REFRESH_BUFFER_MS) {
      return cached.token;
    }
    const pat = this.pats.get(wallet);
    if (pat) {
      const jwt = await this.exchange(pat).catch(() => undefined);
      if (jwt) {
        this.jwts.set(wallet, jwt);
        return jwt.token;
      }
      // PAT expired/revoked — drop it and re-auth.
      this.pats.delete(wallet);
      this.savePats();
    }
    return this.authenticate(wallet, signer);
  }

  /** Full SIWE flow → persist PAT → exchange for JWT. */
  private async authenticate(
    wallet: string,
    signer: SiweSigner,
  ): Promise<string | undefined> {
    try {
      const nonce = await this.requestNonce();
      const issuedAt = new Date().toISOString();
      const message = buildSiweMessage(signer.address, nonce, issuedAt);
      const signature = await signer.signMessage(message);
      const cookie = await this.verify(
        signer.address,
        nonce,
        issuedAt,
        signature,
      );
      const scoped = await this.createScopedToken(cookie, [
        "read:eligibility",
      ]);
      this.pats.set(wallet, scoped.token);
      this.savePats();
      const jwt = await this.exchange(scoped.token);
      this.jwts.set(wallet, jwt);
      return jwt.token;
    } catch (err) {
      this.logger?.warn(
        { wallet, err: err instanceof Error ? err.message : err },
        "wallet SIWE auth failed",
      );
      return undefined;
    }
  }

  private async requestNonce(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/v2/auth/siwe/nonce`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`nonce ${res.status}`);
    const data = (await res.json()) as { nonce: string };
    return data.nonce;
  }

  private async verify(
    address: string,
    nonce: string,
    issuedAt: string,
    signature: string,
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/v2/auth/siwe/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: parsedMessage(address, nonce, issuedAt),
        signature,
        chainArch: "EVM",
      }),
    });
    if (!res.ok) {
      throw new Error(`siwe verify ${res.status}: ${await res.text()}`);
    }
    return extractSessionCookies(res.headers);
  }

  private async createScopedToken(
    cookie: string,
    scopes: string[],
  ): Promise<ScopedToken> {
    const res = await fetch(`${this.baseUrl}/api/v2/auth/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        label: `aco-bot-${Date.now()}`,
        scopes,
        expiresInDays: PAT_EXPIRY_DAYS,
      }),
    });
    if (!res.ok) {
      throw new Error(`scoped token ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as ScopedToken;
  }

  private async exchange(scopedToken: string): Promise<JwtEntry> {
    const res = await fetch(`${this.baseUrl}/api/v2/auth/tokens/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subjectToken: scopedToken,
        subjectTokenType: "ACCESS_TOKEN",
      }),
    });
    if (!res.ok) {
      throw new Error(`token exchange ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      accessToken: string;
      expiresIn?: number;
    };
    return {
      token: data.accessToken,
      expiresAt: Date.now() + (data.expiresIn ?? DEFAULT_JWT_TTL_S) * 1000,
    };
  }
}
