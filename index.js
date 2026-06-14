require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const { Readable } = require('stream');

const app = express();
app.use(express.urlencoded({ extended: false }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

const VAULT_FOLDER_ID = process.env.VAULT_FOLDER_ID;

// Mappa categoria -> nome cartella nel vault
const CATEGORY_FOLDERS = {
  Idea: 'Idee',
  Impegno: 'Impegni',
  Riferimento: 'Riferimenti',
  Nota: 'Inbox'
};

const folderCache = {};

// Trova (o crea) una sottocartella del vault e ne restituisce l'ID
async function getOrCreateFolder(name) {
  if (folderCache[name]) return folderCache[name];

  const res = await drive.files.list({
    q: `'${VAULT_FOLDER_ID}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)'
  });

  if (res.data.files.length > 0) {
    folderCache[name] = res.data.files[0].id;
    return folderCache[name];
  }

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [VAULT_FOLDER_ID]
    },
    fields: 'id'
  });

  folderCache[name] = folder.data.id;
  return folder.data.id;
}

// Estrae il primo oggetto JSON valido dalla risposta di Claude
function extractJson(rawText, fallback) {
  const jsonMatch = (rawText || '').match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : rawText;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return fallback;
  }
}

// Chiede a Claude di classificare un messaggio di testo
async function classifyMessage(text) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `Sei un assistente che organizza note personali. Analizza il messaggio e rispondi SOLO con un oggetto JSON valido, senza testo aggiuntivo, nel formato:
{"categoria": "Idea|Impegno|Riferimento|Nota", "tag": ["tag1","tag2"], "titolo": "titolo breve in 3-6 parole"}

Categorie:
- Idea: pensieri, spunti, progetti futuri
- Impegno: scadenze, cose da fare, appuntamenti
- Riferimento: informazioni utili da conservare, link, contatti
- Nota: tutto il resto`,
    messages: [{ role: 'user', content: text }]
  });

  const raw = msg.content.find(b => b.type === 'text')?.text || '{}';
  return extractJson(raw, { categoria: 'Nota', tag: [], titolo: 'nota-senza-titolo' });
}

// Chiede a Claude di analizzare e classificare uno screenshot
async function classifyImage(base64Data, mediaType) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `Sei un assistente che organizza note personali a partire da screenshot. Analizza l'immagine e rispondi SOLO con un oggetto JSON valido, senza testo aggiuntivo, nel formato:
{"categoria": "Idea|Impegno|Riferimento|Nota", "tag": ["tag1","tag2"], "titolo": "titolo breve in 3-6 parole", "descrizione": "descrizione/trascrizione del contenuto dello screenshot, 1-4 frasi"}

Categorie:
- Idea: pensieri, spunti, progetti futuri
- Impegno: scadenze, cose da fare, appuntamenti
- Riferimento: informazioni utili da conservare, link, contatti
- Nota: tutto il resto`,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
        { type: 'text', text: 'Analizza questo screenshot e classificalo.' }
      ]
    }]
  });

  const raw = msg.content.find(b => b.type === 'text')?.text || '{}';
  return extractJson(raw, { categoria: 'Nota', tag: [], titolo: 'screenshot-senza-titolo', descrizione: '' });
}

// Scarica un allegato da Twilio (richiede autenticazione Basic)
async function downloadTwilioMedia(url) {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!response.ok) {
    throw new Error(`Download allegato Twilio fallito: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function extensionFromMimeType(mimeType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp'
  };
  return map[mimeType] || 'jpg';
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòù\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Crea il file Markdown (ed eventualmente l'immagine collegata) nella cartella corretta del vault
async function saveNote({ categoria, tag, titolo, contenuto, fonte, image }) {
  const folderName = CATEGORY_FOLDERS[categoria] || 'Inbox';
  const folderId = await getOrCreateFolder(folderName);

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const baseName = `${dateStr}-${timeStr}-${slugify(titolo)}`;
  const filename = `${baseName}.md`;

  let bodyContent = contenuto || '';

  if (image) {
    const imageFilename = `${baseName}.${image.extension}`;

    await drive.files.create({
      requestBody: {
        name: imageFilename,
        parents: [folderId],
        mimeType: image.mimeType
      },
      media: {
        mimeType: image.mimeType,
        body: Readable.from(image.buffer)
      }
    });

    bodyContent = `![[${imageFilename}]]\n\n${bodyContent}`;
  }

  const fileContent = `---
data: ${dateStr}
categoria: ${categoria}
tag: [${(tag || []).map(t => `"${t}"`).join(', ')}]
fonte: ${fonte}
---

${bodyContent}
`;

  await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
      mimeType: 'text/markdown'
    },
    media: {
      mimeType: 'text/markdown',
      body: fileContent
    }
  });

  return { folderName, filename };
}

// Webhook chiamato da Twilio quando arriva un messaggio WhatsApp
app.post('/webhook/whatsapp', async (req, res) => {
  const body = req.body.Body;
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  res.set('Content-Type', 'text/xml');

  try {
    // Caso 1: screenshot / immagine
    if (numMedia > 0 && mediaType && mediaType.startsWith('image/')) {
      const imageBuffer = await downloadTwilioMedia(mediaUrl);
      const base64Data = imageBuffer.toString('base64');
      const { categoria, tag, titolo, descrizione } = await classifyImage(base64Data, mediaType);

      const { folderName, filename } = await saveNote({
        categoria,
        tag: tag || [],
        titolo: titolo || 'screenshot',
        contenuto: descrizione || (body || ''),
        fonte: 'WhatsApp (screenshot)',
        image: {
          buffer: imageBuffer,
          mimeType: mediaType,
          extension: extensionFromMimeType(mediaType)
        }
      });

      return res.send(
        `<Response><Message>Salvato in ${folderName}/${filename}\nCategoria: ${categoria}\nTag: ${(tag || []).join(', ')}</Message></Response>`
      );
    }

    // Caso 2: altri allegati (audio, ecc.) - non ancora supportati
    if (numMedia > 0) {
      return res.send(
        '<Response><Message>Ho ricevuto un allegato non supportato (es. audio). Il supporto sara aggiunto in un prossimo step. Per ora invia testo o screenshot.</Message></Response>'
      );
    }

    // Caso 3: messaggio di testo
    if (!body || !body.trim()) {
      return res.send('<Response><Message>Messaggio vuoto, niente da salvare.</Message></Response>');
    }

    const { categoria, tag, titolo } = await classifyMessage(body);
    const { folderName, filename } = await saveNote({
      categoria,
      tag: tag || [],
      titolo: titolo || 'nota',
      contenuto: body,
      fonte: 'WhatsApp'
    });

    res.send(
      `<Response><Message>Salvato in ${folderName}/${filename}\nCategoria: ${categoria}\nTag: ${(tag || []).join(', ')}</Message></Response>`
    );
  } catch (err) {
    console.error(err);
    res.send('<Response><Message>Errore durante il salvataggio della nota. Controlla i log del server.</Message></Response>');
  }
});

app.get('/', (req, res) => res.send('Agente AI Personale - server attivo'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server in ascolto sulla porta ${PORT}`));
