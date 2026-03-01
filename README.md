# ✂️ Estefan Peluquería — Bot v4

WhatsApp chatbot para Estefan Peluquería en Puertos, Buenos Aires.
Arquitectura multi-agente: cada agente tiene una responsabilidad única.

---

## Arquitectura

```
/agents
  orchestrator.js   ← coordina todos los agentes, único que habla con el cliente
  personal.js       ← interpreta mensajes con contexto completo del cliente (Haiku)
  intake.js         ← identifica al cliente, carga su perfil y memoria
  booking.js        ← crea, cancela y reprograma turnos (acciones deterministas)
  loyalty.js        ← puntos, beneficios y canjes
  upsell.js         ← ofrece extras en el momento justo
  memory.js         ← actualiza memoria del cliente en background
  mailer.js         ← emails de confirmación, cancelación y modificación

/core
  db.js             ← todas las queries a PostgreSQL (fuente única de datos)
  calendar.js       ← Google Calendar (OAuth + Service Account)
  sheets.js         ← Google Sheets sync
  session.js        ← sesiones en memoria
  servicios.js      ← catálogo de servicios y precios
  utils.js          ← helpers (formatFecha, normalizeDia, etc.)

index.js            ← servidor HTTP, webhook WhatsApp, endpoints REST
```

## Stack

- **Runtime:** Node.js en Render
- **DB:** PostgreSQL (Render)
- **WhatsApp:** Wassenger API
- **AI:** Claude Haiku — interpreta intenciones con contexto del cliente
- **Calendar:** Google Calendar API
- **Sheets:** Google Sheets API (Service Account)
- **Email:** Gmail SMTP (nodemailer)

---

## Variables de entorno (Render)

| Variable | Descripción |
|---|---|
| `ANTHROPIC_API_KEY` | API key de Anthropic |
| `WASSENGER_API_KEY` | API key de Wassenger |
| `DATABASE_URL` | PostgreSQL connection string |
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | `https://peluqueria-bot.onrender.com/auth/callback` |
| `GOOGLE_CALENDAR_ID` | ID del calendario (o `primary`) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Email de la service account |
| `GOOGLE_PRIVATE_KEY` | Private key de la service account |
| `SHEETS_ID` | ID del Google Sheet de gestión |
| `GMAIL_USER` | Email de Gmail para envío |
| `GMAIL_APP_PASSWORD` | Contraseña de aplicación de Gmail |
| `ADMIN_SECRET` | Password para endpoints `/admin/*` |

---

## Sistema de puntos

- 1 punto cada $1.000 gastados
- Canjes configurables en tabla `loyalty_rewards`
- Para modificar reglas: `agents/loyalty.js`

## Agregar un agente nuevo

1. Crear `/agents/nuevo-agente.js`
2. Exportar las funciones necesarias
3. Importarlo en `agents/orchestrator.js`
4. Agregarlo al routing — no tocar ningún otro archivo
