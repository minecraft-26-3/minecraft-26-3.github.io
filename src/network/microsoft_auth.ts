/**
 * Microsoft OAuth 2.0 Device Code -> Xbox Live -> XSTS -> Minecraft Services -> Session Server Auth
 *
 * Reverse-engineered 1:1 from `Wispcraft-1.12.2.html` (`client_id: "c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb"`):
 * 1. Requests Microsoft OAuth 2.0 Device Code from `https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`
 *    (`scope: "XboxLive.signin XboxLive.offline_access"`).
 * 2. Polls `https://login.microsoftonline.com/consumers/oauth2/v2.0/token` for `access_token` and `refresh_token`.
 * 3. Authenticates with Xbox Live (`https://user.auth.xboxlive.com/user/authenticate` with `RpsTicket: "d=" + msaToken`).
 * 4. Authorizes with XSTS (`https://xsts.auth.xboxlive.com/xsts/authorize` with `RelyingParty: "rp://api.minecraftservices.com/"`).
 * 5. Exchanges XSTS token + `uhs` for Minecraft Services JWT (`https://api.minecraftservices.com/authentication/login_with_xbox`).
 * 6. Queries player UUID & username (`https://api.minecraftservices.com/minecraft/profile`).
 * 7. Computes Minecraft's non-standard two's complement signed SHA-1 hex digest
 *    `sha1(ascii(serverId) + sharedSecret + publicKey)` and posts to
 *    `https://sessionserver.mojang.com/session/minecraft/join`.
 */

import { WispEpoxyClient } from './wisp_epoxy';

export const MICROSOFT_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';

export interface DeviceCodeInfo {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
    message: string;
}

export interface MinecraftProfile {
    id: string;        // 32-char hex UUID without dashes
    name: string;      // Player username
    accessToken: string;
    refreshToken?: string;
    offlineMode: boolean;
}

export class MicrosoftAuthenticator {
    private wisp: WispEpoxyClient;

    constructor(wisp: WispEpoxyClient) {
        this.wisp = wisp;
    }

    /**
     * Step 1: Request OAuth 2.0 Device Code from Microsoft consumer endpoint.
     */
    public async requestDeviceCode(): Promise<DeviceCodeInfo> {
        const resp = await this.wisp.epoxyFetch(
            'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `client_id=${MICROSOFT_CLIENT_ID}&scope=${encodeURIComponent('XboxLive.signin XboxLive.offline_access')}`,
            }
        );
        const json = await resp.json();
        if (!json.device_code || !json.user_code) {
            throw new Error(json.error_description || 'Failed to obtain Microsoft OAuth2 device code');
        }
        return {
            deviceCode: json.device_code,
            userCode: json.user_code,
            verificationUri: json.verification_uri || 'https://www.microsoft.com/link',
            expiresIn: json.expires_in || 900,
            interval: json.interval || 5,
            message: json.message || `Go to ${json.verification_uri} and enter code ${json.user_code}`,
        };
    }

    /**
     * Step 2: Poll token endpoint with `device_code` until user completes sign-in.
     */
    public async pollDeviceCodeToken(
        deviceCode: string,
        intervalSec = 5,
        onStatus?: (status: string) => void
    ): Promise<{ accessToken: string; refreshToken: string }> {
        const pollMs = Math.max(3, intervalSec) * 1000;
        for (let attempt = 0; attempt < 120; attempt++) {
            await new Promise(r => setTimeout(r, pollMs));
            const resp = await this.wisp.epoxyFetch(
                'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body:
                        'grant_type=urn:ietf:params:oauth:grant-type:device_code' +
                        `&client_id=${MICROSOFT_CLIENT_ID}` +
                        `&device_code=${encodeURIComponent(deviceCode)}`,
                }
            );
            const json = await resp.json();
            if (json.error) {
                if (json.error === 'authorization_pending') {
                    onStatus?.('Waiting for user to authorize in browser...');
                    continue;
                }
                if (json.error === 'slow_down') {
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }
                throw new Error(`Microsoft OAuth error: ${json.error_description || json.error}`);
            }
            if (json.access_token) {
                return {
                    accessToken: json.access_token,
                    refreshToken: json.refresh_token || '',
                };
            }
        }
        throw new Error('Device code authentication timed out');
    }

    /**
     * Refresh an existing Microsoft `refresh_token` stored in `localStorage`.
     */
    public async refreshMsaToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
        const resp = await this.wisp.epoxyFetch(
            'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:
                    'grant_type=refresh_token' +
                    `&client_id=${MICROSOFT_CLIENT_ID}` +
                    `&refresh_token=${encodeURIComponent(refreshToken)}`,
            }
        );
        const json = await resp.json();
        if (!json.access_token) {
            throw new Error(json.error_description || 'Failed to refresh Microsoft token');
        }
        return {
            accessToken: json.access_token,
            refreshToken: json.refresh_token || refreshToken,
        };
    }

    /**
     * Step 3, 4, 5, 6: Exchange MSA `access_token` -> Xbox Live Token -> XSTS Token -> Minecraft Services Token -> Profile.
     */
    public async authenticateMinecraftWithMsaToken(msaAccessToken: string, refreshToken?: string): Promise<MinecraftProfile> {
        // Step 3: Xbox Live User Authenticate
        const xblResp = await this.wisp.epoxyFetch('https://user.auth.xboxlive.com/user/authenticate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                Properties: {
                    AuthMethod: 'RPS',
                    SiteName: 'user.auth.xboxlive.com',
                    RpsTicket: `d=${msaAccessToken}`,
                },
                RelyingParty: 'http://auth.xboxlive.com',
                TokenType: 'JWT',
            }),
        });
        const xblJson = await xblResp.json();
        if (!xblJson.Token) {
            throw new Error('Xbox Live did not return an authentication token');
        }

        // Step 4: XSTS Authorize
        const xstsResp = await this.wisp.epoxyFetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                Properties: {
                    SandboxId: 'RETAIL',
                    UserTokens: [xblJson.Token],
                },
                RelyingParty: 'rp://api.minecraftservices.com/',
                TokenType: 'JWT',
            }),
        });
        const xstsJson = await xstsResp.json();
        if (xstsJson.XErr) {
            switch (xstsJson.XErr) {
                case 2148916227:
                    throw new Error('XSTS: This account is banned from Xbox');
                case 2148916233:
                    throw new Error('XSTS: This Microsoft account does not have an Xbox profile');
                case 2148916235:
                    throw new Error('XSTS: Xbox Live is not available in your country');
                case 2148916236:
                case 2148916237:
                    throw new Error('XSTS: Account requires adult verification');
                case 2148916238:
                    throw new Error('XSTS: Account is under 18 and must be added to a Microsoft Family');
                default:
                    throw new Error(`XSTS error code: ${xstsJson.XErr}`);
            }
        }
        const xstsToken = xstsJson.Token;
        const userHash = xstsJson?.DisplayClaims?.xui?.[0]?.uhs;
        if (!xstsToken || !userHash) {
            throw new Error('XSTS response missing Token or DisplayClaims.xui[0].uhs');
        }

        // Step 5: Minecraft Services login_with_xbox
        const mcLoginResp = await this.wisp.epoxyFetch(
            'https://api.minecraftservices.com/authentication/login_with_xbox',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({
                    identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
                }),
            }
        );
        const mcLoginJson = await mcLoginResp.json();
        const mcAccessToken = mcLoginJson.access_token;
        if (!mcAccessToken) {
            throw new Error('Minecraft Services did not return an access_token');
        }

        // Step 6: Fetch Minecraft Profile (UUID + Username)
        const profileResp = await this.wisp.epoxyFetch('https://api.minecraftservices.com/minecraft/profile', {
            headers: {
                Authorization: `Bearer ${mcAccessToken}`,
            },
        });
        const profileJson = await profileResp.json();
        if (!profileJson.id || !profileJson.name) {
            throw new Error('This Microsoft account does not own Minecraft: Java Edition');
        }

        return {
            id: profileJson.id,
            name: profileJson.name,
            accessToken: mcAccessToken,
            refreshToken,
            offlineMode: false,
        };
    }

    /**
     * Computes Minecraft's signed two's complement SHA-1 serverId hash (`Crypt.digestData`):
     * `sha1(ascii(serverId) + sharedSecret + publicKey)`
     * If the 160-bit big-endian result has its most significant bit set, formats as `"-"` + `(-val).toString(16)`.
     */
    public static async computeMinecraftServerIdHash(
        serverId: string,
        sharedSecret: Uint8Array,
        serverPublicKeyDer: Uint8Array
    ): Promise<string> {
        const asciiServerId = new TextEncoder().encode(serverId);
        const combined = new Uint8Array(asciiServerId.length + sharedSecret.length + serverPublicKeyDer.length);
        combined.set(asciiServerId, 0);
        combined.set(sharedSecret, asciiServerId.length);
        combined.set(serverPublicKeyDer, asciiServerId.length + sharedSecret.length);

        const hashBuffer = await crypto.subtle.digest('SHA-1', combined);
        const hashBytes = new Uint8Array(hashBuffer);

        let bigVal = 0n;
        for (let i = 0; i < hashBytes.length; i++) {
            bigVal = (bigVal << 8n) | BigInt(hashBytes[i]);
        }
        // Check 160-bit sign bit (bit 159)
        if ((hashBytes[0] & 0x80) !== 0) {
            const twosComp = (1n << 160n) - bigVal;
            return '-' + twosComp.toString(16);
        }
        return bigVal.toString(16);
    }

    /**
     * Step 7: Join a multiplayer server via Mojang Session Server (`https://sessionserver.mojang.com/session/minecraft/join`).
     */
    public async joinMojangServerSession(
        accessToken: string,
        selectedProfileUuid: string,
        serverId: string,
        sharedSecret: Uint8Array,
        serverPublicKeyDer: Uint8Array
    ): Promise<void> {
        const serverHash = await MicrosoftAuthenticator.computeMinecraftServerIdHash(
            serverId,
            sharedSecret,
            serverPublicKeyDer
        );
        const resp = await this.wisp.epoxyFetch('https://sessionserver.mojang.com/session/minecraft/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accessToken,
                selectedProfile: selectedProfileUuid.replace(/-/g, ''),
                serverId: serverHash,
            }),
        });
        if (resp.status !== 204 && !resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Mojang Session Server rejected join (${resp.status}): ${text}`);
        }
    }

    /**
     * Creates an offline-mode profile with a deterministic v3-like UUID from the player's username
     * (`UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))`).
     */
    public static createOfflineProfile(username: string): MinecraftProfile {
        const cleanName = (username || 'Player26_3').trim().slice(0, 16);
        let h1 = 0xdeadbeef ^ cleanName.length;
        let h2 = 0x41c6ce57 ^ cleanName.length;
        for (let i = 0; i < cleanName.length; i++) {
            const ch = cleanName.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
        const uuid = `${hex(h1)}${hex(h2)}${hex(h1 ^ 0x12345678)}${hex(h2 ^ 0x87654321)}`;
        return {
            id: uuid,
            name: cleanName,
            accessToken: '',
            offlineMode: true,
        };
    }
}
