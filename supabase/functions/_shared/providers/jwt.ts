// Local JWT signing with WebCrypto. Used by App Store Connect (ES256 team key) and Google Play
// (RS256 service-account key). Signing happens in-process: nothing is sent anywhere here.
import { b64Decode, b64urlEncode } from '../crypto.ts';
import { SyncError } from './ctx.ts';

const te = new TextEncoder();

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/[\r\n\s]/g, '');
  if (!body) throw new SyncError('Private key is empty');
  try {
    return b64Decode(body);
  } catch {
    throw new SyncError('Private key is not valid PEM/base64');
  }
}

function b64urlJson(o: unknown): string {
  return b64urlEncode(te.encode(JSON.stringify(o)));
}

/** Sign a JWT. `pem` must be a PKCS#8 "BEGIN PRIVATE KEY" block (Apple .p8 and Google SA keys both are). */
export async function signJwt(alg: 'ES256' | 'RS256', pem: string, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  if (/BEGIN (EC|RSA) PRIVATE KEY/.test(pem)) {
    throw new SyncError(`Private key is PKCS#1/SEC1; a PKCS#8 "BEGIN PRIVATE KEY" block is required`);
  }
  const der = pemToDer(pem);
  const importAlg = alg === 'ES256'
    ? ({ name: 'ECDSA', namedCurve: 'P-256' } as EcKeyImportParams)
    : ({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as RsaHashedImportParams);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', der as BufferSource, importAlg, false, ['sign']);
  } catch (e) {
    throw new SyncError(`Private key could not be imported for ${alg}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const signingInput = `${b64urlJson({ alg, typ: 'JWT', ...header })}.${b64urlJson(payload)}`;
  const signAlg = alg === 'ES256'
    ? ({ name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams)
    : ({ name: 'RSASSA-PKCS1-v1_5' } as AlgorithmIdentifier);
  // WebCrypto ECDSA output is already the raw r||s form JWS expects (no DER conversion needed).
  const sig = new Uint8Array(await crypto.subtle.sign(signAlg, key, te.encode(signingInput) as BufferSource));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

export const nowSeconds = (now: Date): number => Math.floor(now.getTime() / 1000);
