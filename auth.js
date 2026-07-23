import jwt from 'jsonwebtoken';

// The extension gets an OAuth *access token* via chrome.identity.getAuthToken()
// (the standard one-click flow for Chrome extensions — uses the browser's signed-in
// Google account). We verify it server-side against Google's tokeninfo endpoint,
// which also confirms it was issued for our own OAuth client (aud check).
export async function verifyGoogleAccessToken(accessToken) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error('Server misconfiguration: GOOGLE_CLIENT_ID is not set on the backend');
  }
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
  if (!res.ok) throw new Error('Invalid Google access token');
  const info = await res.json();
  if (info.aud !== process.env.GOOGLE_CLIENT_ID) {
    console.error(`Google token audience mismatch — token aud="${info.aud}", server GOOGLE_CLIENT_ID="${process.env.GOOGLE_CLIENT_ID}"`);
    throw new Error('Token was not issued for this app (client ID mismatch)');
  }
  if (!info.email || info.email_verified !== 'true') throw new Error('Google account email not verified');
  return { email: info.email, sub: info.sub };
}

export function issueSessionToken(email) {
  return jwt.sign({ email }, process.env.SESSION_JWT_SECRET, { expiresIn: '30d' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const decoded = jwt.verify(token, process.env.SESSION_JWT_SECRET);
    req.userEmail = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Used by routes that should work BOTH for signed-in paying users (Bearer session
// token) and for brand-new anonymous visitors still on their free 10 pages
// (X-Anonymous-Id header, no sign-in required). Attaches req.userEmail OR req.anonId.
export function identifyQuotaSubject(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.SESSION_JWT_SECRET);
      req.userEmail = decoded.email;
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
  }
  const anonId = req.headers['x-anonymous-id'];
  if (anonId) {
    req.anonId = String(anonId);
    return next();
  }
  res.status(400).json({ error: 'Missing session token or X-Anonymous-Id header' });
}
