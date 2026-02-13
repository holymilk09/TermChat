// Telegram Bridge — removed
//
// TermChat is a standalone messaging platform. The Telegram bridge stub
// that lived here has been removed because:
//   1. We build our own native clients (iOS, Android, web).
//   2. The Bot API routes (/api/bot/*) already provide a Telegram-compatible
//      interface for external bot developers — no bridge needed.
//   3. Keeping dead stub code creates confusion about what's real.
//
// If cross-platform bridging is ever needed (e.g. Matrix, XMPP), implement
// it as a standalone micro-service that talks to the TermChat API rather
// than embedding it in the core server.
