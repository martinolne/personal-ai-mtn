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

// Trascrive un audio usando Google Cloud Speech-to-Text
async function transcribeAudio(buffer, mimeType) {
  const apiKey = process.env.GOOGLE_SPEECH_API_KEY;
  const audioBase64 = buffer.toString('base64');

  // I messaggi vocali WhatsApp arrivano tipicamente come audio/ogg con codec opus, 16kHz
  const config = {
    encoding: 'OGG_OPUS',
    sampleRateHertz: 16000,
    languageCode: 'it-IT'
  };

  const response = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config,
      audio: { content: audioBase64 }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Trascrizione fallita: ${JSON.stringify(data)}`);
  }

  return (data.results || [])
    .map(r => r.alternatives?.[0]?.transcript || '')
    .join(' ')
    .trim();
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

// Invia un messaggio WhatsApp tramite le API REST di Twilio
async function sendWhatsAppMessage(from, to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const params = new URLSearchParams();
  params.append('From', from);
  params.append('To', to);
  params.append('Body', body);

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('Errore invio messaggio Twilio:', response.status, text);
  } else {
    console.log('Risposta inviata su WhatsApp con successo');
  }
}

// Elabora il messaggio in arrivo (eseguito dopo aver risposto a Twilio)
async function processIncomingMessage(payload) {
  const body = payload.Body;
  const from = payload.From; // numero dell'utente, es. whatsapp:+39...
  const to = payload.To;     // numero sandbox Twilio, es. whatsapp:+14155238886
  const numMedia = parseInt(payload.NumMedia || '0', 10);
  const mediaUrl = payload.MediaUrl0;
  const mediaType = payload.MediaContentType0;

  let replyText;

  try {
    // Caso 1: screenshot / immagine
    if (numMedia > 0 && mediaType && mediaType.startsWith('image/')) {
      console.log('Elaboro screenshot...');
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

      replyText = `Salvato in ${folderName}/${filename}\nCategoria: ${categoria}\nTag: ${(tag || []).join(', ')}`;

    // Caso 2: messaggio vocale
    } else if (numMedia > 0 && mediaType && mediaType.startsWith('audio/')) {
      console.log('Elaboro messaggio vocale...');
      const audioBuffer = await downloadTwilioMedia(mediaUrl);
      const transcript = await transcribeAudio(audioBuffer, mediaType);

      if (!transcript) {
        replyText = 'Non sono riuscito a trascrivere il messaggio vocale (nessun testo riconosciuto).';
      } else {
        const { categoria, tag, titolo } = await classifyMessage(transcript);
        const { folderName, filename } = await saveNote({
          categoria,
          tag: tag || [],
          titolo: titolo || 'nota-vocale',
          contenuto: `Trascrizione vocale:\n\n${transcript}`,
          fonte: 'WhatsApp (vocale)'
        });

        replyText = `Salvato in ${folderName}/${filename}\nCategoria: ${categoria}\nTag: ${(tag || []).join(', ')}\n\nTrascrizione: ${transcript}`;
      }

    // Caso 3: altri allegati - non ancora supportati
    } else if (numMedia > 0) {
      replyText = 'Ho ricevuto un allegato non supportato. Per ora invia testo, screenshot o messaggi vocali.';

    // Caso 4: messaggio di testo
    } else if (!body || !body.trim()) {
      replyText = 'Messaggio vuoto, niente da salvare.';

    } else {
      console.log('Elaboro messaggio di testo...');
      const { categoria, tag, titolo } = await classifyMessage(body);
      const { folderName, filename } = await saveNote({
        categoria,
        tag: tag || [],
        titolo: titolo || 'nota',
        contenuto: body,
        fonte: 'WhatsApp'
      });

      replyText = `Salvato in ${folderName}/${filename}\nCategoria: ${categoria}\nTag: ${(tag || []).join(', ')}`;
    }
  } catch (err) {
    console.error('Errore durante l\'elaborazione:', err);
    replyText = 'Errore durante il salvataggio della nota. Controlla i log del server.';
  }

  console.log('Invio risposta:', replyText);
  await sendWhatsAppMessage(to, from, replyText);
}

// Webhook chiamato da Twilio quando arriva un messaggio WhatsApp
app.post('/webhook/whatsapp', (req, res) => {
  console.log('Messaggio ricevuto da', req.body.From);

  // Risponde subito a Twilio per evitare timeout, poi elabora in background
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  processIncomingMessage(req.body).catch(err => {
    console.error('Errore non gestito nell\'elaborazione:', err);
  });
});

app.get('/', (req, res) => res.send('Agente AI Personale - server attivo'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server in ascolto sulla porta ${PORT}`));
