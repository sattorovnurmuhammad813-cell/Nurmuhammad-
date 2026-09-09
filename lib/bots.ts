export interface BotConfig {
  /** Ichki qisqa identifikator - Redis kalitlarida va webhook yo'lida ishlatiladi */
  id: string;
  token: string;
  webhookSecret?: string;
}

function buildBot(id: string, tokenEnv: string, secretEnv: string): BotConfig | null {
  const token = process.env[tokenEnv];
  if (!token) return null;
  return { id, token, webhookSecret: process.env[secretEnv] };
}

/** Faqat token sozlangan botlarni qaytaradi - shuning uchun 1 yoki 2 bot bilan ham ishlayveradi */
export function getConfiguredBots(): BotConfig[] {
  const bots = [
    buildBot("a", "BOT_TOKEN", "WEBHOOK_SECRET"),
    buildBot("b", "BOT_TOKEN_2", "WEBHOOK_SECRET_2"),
  ];
  return bots.filter((b): b is BotConfig => b !== null);
}

export function getBot(id: string): BotConfig {
  const bot = getConfiguredBots().find((b) => b.id === id);
  if (!bot) {
    throw new Error(`Bot "${id}" uchun token sozlanmagan (BOT_TOKEN yoki BOT_TOKEN_2 env var)`);
  }
  return bot;
}
