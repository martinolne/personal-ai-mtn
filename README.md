# Agente AI Personale - Prototipo v0.1

Server minimo che riceve messaggi WhatsApp di testo via Twilio, li classifica
con Claude (categoria, tag, titolo) e crea una nota Markdown nella cartella
corretta del vault Obsidian su Google Drive.

Limiti di questa versione: gestisce solo testo. Allegati audio/immagine
vengono riconosciuti ma non elaborati (risposta automatica che lo segnala).

## 1. Trovare il VAULT_FOLDER_ID

Apri Google Drive nel browser, entra nella cartella principale del vault
Obsidian. L'URL sara del tipo:

  https://drive.google.com/drive/folders/XXXXXXXXXXXXXXXXXXXXXXXXXXXX

La parte dopo "folders/" e il VAULT_FOLDER_ID.

## 2. Configurare le variabili d'ambiente

Copia .env.example in .env e compila:

- ANTHROPIC_API_KEY: chiave API Anthropic (da console.anthropic.com)
- GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET: dal client OAuth creato su Google Cloud
- GOOGLE_REFRESH_TOKEN: ottenuto da OAuth Playground
- VAULT_FOLDER_ID: l'ID trovato al punto 1
- PORT: lasciare 3000 (Render lo sovrascrive comunque)

## 3. Test in locale (opzionale)

Se hai Node.js installato:

  npm install
  npm start

Il server risponde su http://localhost:3000

## 4. Deploy su Render

1. Crea un repository su GitHub e carica tutti i file di questa cartella
   (incluso package.json, NON includere il file .env con le chiavi vere).
2. Su Render.com: "New" -> "Web Service" -> collega il repository GitHub.
3. Configurazione:
   - Build Command: npm install
   - Start Command: npm start
   - Plan: Free
4. In "Environment", aggiungi tutte le variabili presenti in .env.example
   con i valori reali.
5. Esegui il deploy. Render fornira un URL del tipo:
   https://nome-progetto.onrender.com

## 5. Collegare Twilio

1. Vai nella console Twilio, sezione WhatsApp Sandbox (o numero WhatsApp configurato).
2. Nel campo "WHEN A MESSAGE COMES IN", inserisci:
   https://nome-progetto.onrender.com/webhook/whatsapp
   Metodo: HTTP POST
3. Salva.

## 6. Test

Manda un messaggio di testo al numero WhatsApp Twilio (es. "Idea: creare
una newsletter mensile per i pazienti"). Dovresti ricevere una risposta con
la cartella e il file creato, e trovare il nuovo file .md nel vault su Drive.

## Note sul piano free di Render

Il piano free "dorme" dopo un periodo di inattivita e si risveglia alla
prima richiesta, con qualche secondo di ritardo sulla prima risposta. Per
un uso personale e accettabile; se diventa un problema si valuta un piano
a pagamento o un altro provider.
