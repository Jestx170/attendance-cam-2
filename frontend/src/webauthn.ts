const API_URL = "/api";

export function isWebAuthnSupported(): boolean {
  return typeof window !== 'undefined' &&
    !!window.PublicKeyCredential &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function';
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  try {
    return await (PublicKeyCredential as any).isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function b64urlToBuf(s: string): ArrayBuffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function bufToB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCreationOptions(opts: any): PublicKeyCredentialCreationOptions {
  return {
    ...opts,
    challenge: b64urlToBuf(opts.challenge),
    user: { ...opts.user, id: b64urlToBuf(opts.user.id) },
    excludeCredentials: (opts.excludeCredentials ?? []).map((c: any) => ({
      ...c, id: b64urlToBuf(c.id),
    })),
  };
}

function decodeRequestOptions(opts: any): PublicKeyCredentialRequestOptions {
  return {
    ...opts,
    challenge: b64urlToBuf(opts.challenge),
    allowCredentials: (opts.allowCredentials ?? []).map((c: any) => ({
      ...c, id: b64urlToBuf(c.id),
    })),
  };
}

function encodeAttestation(cred: PublicKeyCredential): any {
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: (cred as any).authenticatorAttachment ?? null,
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      attestationObject: bufToB64url(r.attestationObject),
      transports: (r as any).getTransports?.() ?? [],
    },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
  };
}

function encodeAssertion(cred: PublicKeyCredential): any {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: (cred as any).authenticatorAttachment ?? null,
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      authenticatorData: bufToB64url(r.authenticatorData),
      signature: bufToB64url(r.signature),
      userHandle: r.userHandle ? bufToB64url(r.userHandle) : null,
    },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
  };
}

export async function enrollPasskey(empId: string, token: string): Promise<{ name: string }> {
  const beginRes = await fetch(`${API_URL}/webauthn/register/begin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ emp_id: empId }),
  });
  if (!beginRes.ok) throw new Error((await beginRes.json()).detail || 'begin failed');
  const { session, options } = await beginRes.json();

  const cred = await navigator.credentials.create({ publicKey: decodeCreationOptions(options) });
  if (!cred) throw new Error('User cancelled');

  const completeRes = await fetch(`${API_URL}/webauthn/register/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ session, credential: encodeAttestation(cred as PublicKeyCredential) }),
  });
  if (!completeRes.ok) throw new Error((await completeRes.json()).detail || 'verify failed');
  return await completeRes.json();
}

export async function authenticateWithPasskey(): Promise<{
  status: string; name: string; action: string; message: string; time: string;
}> {
  const beginRes = await fetch(`${API_URL}/webauthn/auth/begin`, { method: 'POST' });
  if (!beginRes.ok) throw new Error((await beginRes.json()).detail || 'begin failed');
  const { session, options } = await beginRes.json();

  const cred = await navigator.credentials.get({ publicKey: decodeRequestOptions(options) });
  if (!cred) throw new Error('User cancelled');

  const completeRes = await fetch(`${API_URL}/webauthn/auth/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, credential: encodeAssertion(cred as PublicKeyCredential) }),
  });
  if (!completeRes.ok) throw new Error((await completeRes.json()).detail || 'verify failed');
  return await completeRes.json();
}
