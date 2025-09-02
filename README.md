# WEB P2P Taskzz — Local-First P2P Tasks

[![WEB P2P Taskzz — Screenshot](https://github.com/scrntprcrz/web-p2p-taskzz/blob/main/Screenshot.png?raw=1)](https://github.com/scrntprcrz/web-p2p-taskzz/blob/main/Screenshot.png?raw=1)

## What is it?

WEB P2P Taskzz is a _local-first_ task app that syncs browsers **peer-to-peer** via **WebRTC**.
**Socket.IO** is used for **signaling only**; **no data backend** — everything stays in the browser (`localStorage`).

### Highlights

-   **Real P2P:** WebRTC DataChannels for data; **Socket.IO** just for signaling.
-   **Local-first & offline:** uses `localStorage`.
-   **Fast UX:** fuzzy search (Fuse), toasts, bulk actions.

### Architecture (brief)

-   **Client:** Alpine.js + Bootstrap; local store in `localStorage`.
-   **Signaling:** Socket.IO server (`server.mjs`) for `offer/answer/candidates`.
-   **Data:** WebRTC DataChannels between peers; LWW convergence with `timestamp:peerId` clock.

### Quick Start

```bash
npm i
npm run dev
# → http://localhost:3000
```

## ¿Qué es?

WEB P2P Taskzz es una micro-app de tareas _local-first_ que sincroniza navegadores entre sí usando **WebRTC**.
La **señalización** va por **Socket.IO** y **no hay backend de datos**: todo vive en el navegador (`localStorage`).

### Highlights

-   **P2P real:** WebRTC DataChannels para datos; **Socket.IO** solo para señalización.
-   **Local-first y offline:** almacenamiento en `localStorage`.
-   **UX rápida:** búsqueda difusa (Fuse), toasts, acciones en lote.

### Arquitectura (resumen)

-   **Cliente (browser):** Alpine.js + Bootstrap; store en `localStorage`.
-   **Señalización:** Socket.IO (`server.mjs`) para `offer/answer/candidates`.
-   **Datos:** WebRTC DataChannels entre peers; convergencia LWW con reloj `timestamp:peerId`.

### Inicio rapido

```bash
npm i
npm run dev
# → http://localhost:3000
```
