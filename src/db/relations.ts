// src/db/relations.ts
//
// Relations Drizzle (utilitário para `db.query.*` API). Vazio inicialmente
// porque o worker desta feature usa apenas SELECT/INSERT/UPDATE diretos via
// `db.select().from(...)`. Quando o worker começar a precisar de joins
// agradáveis via `db.query.messages.findMany({ with: { contact: true, ... } })`,
// adicionar relations aqui.
//
// Esta seria a outra metade do output de `npm run db:pull` (que está
// bloqueado por bug do drizzle-kit — ver follow-up #4 em notes.md).

export {};
