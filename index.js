require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

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

// Chiede a Claude di classificare il messaggio
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
  try {
    return JSON.parse(raw);
  } catch {
    return { categoria: 'Nota', tag: [], titolo: 'nota-senza-titolo' };
  }
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòù\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Crea il file Markdown nella cartella corretta del vault
async function saveNote({ categoria, tag, titolo, contenuto, fonte }) {
  const folderName = CATEGORY_FOLDERS[categoria] || 'Inbox';
  const folderId = await getOrCreateFolder(folderName);

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const filename = `${dateStr}-${timeStr}-${slugify(titolo)}.md`;

  const fileContent = `---
data: ${dateStr}
categoria: ${categoria}
tag: [${(tag || []).map(t => `"${t}"`).join(', ')}]
fonte: ${fonte}
---

${contenuto}
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

  res.set('Content-Type', 'text/xml');

  if (numMedia > 0) {
    return res.send(
      '<Response><Message>Ho ricevuto un allegato (audio/immagine). Il supporto per questi contenuti sara aggiunto in un prossimo step. Per ora invia il contenuto come testo.</Message></Response>'
    );
  }

  if (!body || !body.trim()) {
    return res.send('<Response><Message>Messaggio vuoto, niente da salvare.</Message></Response>');
  }

  try {
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
