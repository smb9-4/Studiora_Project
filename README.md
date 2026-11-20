# Studiora AI

A local, private study assistant: **Flask + SQLite** backend, **plain HTML / CSS / JS** frontend, answers streamed from **Ollama**.

## Run

```bash
pip install -r requirements.txt
ollama pull qwen2.5:7b
ollama pull nomic-embed-text      # optional: smarter document search
ollama serve                      # if it isn't already running
python app.py                     # http://127.0.0.1:5001
```

Optional environment variables: `STUDIORA_MODEL` (default `qwen2.5:7b`), `STUDIORA_EMBED_MODEL`,
`STUDIORA_NUM_CTX` (default `8192`), `OLLAMA_URL`, `SECRET_KEY`, `PORT`.

## What's new in this version

* **Numbered lists fixed** – `1, 2, 3` stay in order even when bullet points sit under each number.
* **Files stay in the chat** – while a file is uploading / waiting to be sent it shows in the typing bar;
  once you send it, it moves to the *In this chat* tray beside the **Files** button. Uploaded files can't be
  removed from a chat (deleting the chat removes them).
* **Better RAG** – heading-aware chunks, BM25 + semantic ranking fused (RRF), neighbouring chunks, follow-up
  questions ("and its drawbacks?") are expanded with the previous question, specific questions no longer
  get treated as "summarise the file".
* **Friendly greeting** – "hi" gets a personal, time-of-day greeting with one-click starter chips.
* **PDF / Word documents with boxes** – say *"Create a PDF of short notes on …"* (or "Word", or "both").
  Each file has an at-a-glance box, a **concept-map diagram** (boxes + arrows), key-concept boxes, sections,
  tables and "Remember" call-outs. Based on your uploaded file when there is one. Use the **Create** button
  for ready-made prompts.
* **Diagrams with zoom** – *"Draw a diagram of …"* builds grouped boxes + arrows (Client → App → AI → Data
  style). Scroll / pinch / buttons to zoom, drag to pan, Fit, full screen, download PNG.
* **Tap-to-answer MCQ** – only when you say e.g. *"Ask me MCQ questions one by one on …"*. Tap an option, get
  instant feedback + explanation, then *Next question* / *End quiz* (score table). Otherwise questions are
  answered by typing as usual.

Optional env vars for documents: `STUDIORA_DOC_NUM_CTX` (default 12288), `STUDIORA_DOC_MAX_TOKENS` (6000).

## Notes

* Supported uploads: PDF, DOCX, TXT, MD, CSV. Scanned (image-only) PDFs need OCR first.
* Fonts load from Google Fonts when online and fall back to system fonts offline.
* Set a real `SECRET_KEY` before exposing this beyond your own machine.
