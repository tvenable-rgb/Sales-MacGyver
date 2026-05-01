const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: 'https://revenue-diagnostic.netlify.app'
}));

app.use(express.json({ limit: '2mb' }));

// ── Claude proxy ──────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Website scraper v2 — structured extraction ───────────────
app.post('/api/scrape', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SalesMacGyverBot/1.0; +https://salesmacgyver.com)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(15000)
    });
    const html = await response.text();

    // Strip script/style/noscript blocks first
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

    // Helper to extract content between tags
    const extractTag = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
      const matches = [];
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        const text = m[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text && text.length > 2 && text.length < 300) matches.push(text);
      }
      return matches;
    };

    // Helper to extract meta tag content
    const extractMeta = (name) => {
      const patterns = [
        new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, 'i')
      ];
      for (const re of patterns) {
        const m = cleaned.match(re);
        if (m) return m[1].trim();
      }
      return null;
    };

    // Pull structured pieces
    const title = extractTag('title')[0] || null;
    const h1s = extractTag('h1');
    const h2s = extractTag('h2').slice(0, 5);
    const ogTitle = extractMeta('og:title');
    const ogDesc = extractMeta('og:description');
    const metaDesc = extractMeta('description');
    const twitterTitle = extractMeta('twitter:title');
    const twitterDesc = extractMeta('twitter:description');

    // Body text excerpt for context
    const bodyText = cleaned
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);

    // Build tagged content for the prompt
    const contentBlocks = [
      title ? `<title>${title}</title>` : '',
      ogTitle ? `<og:title>${ogTitle}</og:title>` : '',
      twitterTitle ? `<twitter:title>${twitterTitle}</twitter:title>` : '',
      h1s.length ? `<h1>${h1s.join(' | ')}</h1>` : '',
      h2s.length ? `<h2>${h2s.join(' | ')}</h2>` : '',
      ogDesc ? `<og:description>${ogDesc}</og:description>` : '',
      metaDesc ? `<meta:description>${metaDesc}</meta:description>` : '',
      twitterDesc ? `<twitter:description>${twitterDesc}</twitter:description>` : '',
      `<body>${bodyText}</body>`
    ].filter(Boolean).join('\n').slice(0, 4000);

    res.json({
      content: contentBlocks,
      structured: { title, h1s, h2s, ogTitle, ogDesc, metaDesc, twitterTitle, twitterDesc }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Send email via Microsoft Graph ───────────────────────────
app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, htmlBody, bcc } = req.body;

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: process.env.MS_CLIENT_ID,
          client_secret: process.env.MS_CLIENT_SECRET,
          scope: 'https://graph.microsoft.com/.default'
        })
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('MS token failed: ' + JSON.stringify(tokenData));

    const emailPayload = {
      message: {
        subject,
        body: { contentType: 'HTML', content: htmlBody },
        toRecipients: [{ emailAddress: { address: to } }],
        bccRecipients: bcc ? [{ emailAddress: { address: bcc } }] : []
      },
      saveToSentItems: true
    };

    const sendRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${process.env.MS_SENDER_EMAIL}/sendMail`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailPayload)
      }
    );

    if (sendRes.status === 202) {
      res.json({ success: true });
    } else {
      const errData = await sendRes.text();
      throw new Error('Send failed: ' + errData);
    }
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Log to Google Sheets ──────────────────────────────────────
app.post('/api/log-sheet', async (req, res) => {
  try {
    const { row } = req.body;
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const now = Math.floor(Date.now() / 1000);

    const { createSign } = require('crypto');
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    })).toString('base64url');

    const sign = createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(serviceAccount.private_key, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Google token failed');

    const sheetRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: [row] })
      }
    );

    if (sheetRes.ok) {
      res.json({ success: true });
    } else {
      const errData = await sheetRes.text();
      throw new Error('Sheet append failed: ' + errData);
    }
  } catch (err) {
    console.error('Sheet error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Save HTML report to Google Drive ──────────────────────────
app.post('/api/save-to-drive', async (req, res) => {
  try {
    const { filename, htmlContent } = req.body;
    if (!filename || !htmlContent) return res.status(400).json({ error: 'filename and htmlContent required' });

    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID env var not set');

    const now = Math.floor(Date.now() / 1000);
    const { createSign } = require('crypto');
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/drive.file',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    })).toString('base64url');

    const sign = createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(serviceAccount.private_key, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Drive token failed: ' + JSON.stringify(tokenData));

    // Multipart upload — metadata + file content in one request
    const boundary = '-------SalesMacGyverBoundary' + Date.now();
    const metadata = {
      name: filename,
      parents: [folderId],
      mimeType: 'text/html'
    };
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) + `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html\r\n\r\n` +
      htmlContent + `\r\n` +
      `--${boundary}--`;

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body
      }
    );

    if (!uploadRes.ok) {
      const errData = await uploadRes.text();
      throw new Error('Drive upload failed: ' + errData);
    }

    const fileData = await uploadRes.json();
    res.json({ success: true, fileId: fileData.id, link: fileData.webViewLink });
  } catch (err) {
    console.error('Drive error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Sales MacGyver proxy running');
});
