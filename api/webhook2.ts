import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleWebhook } from "../lib/webhookHandler";
import { getBot } from "../lib/bots";

// Bot B (ikkinchi bot): BOT_TOKEN_2 / WEBHOOK_SECRET_2 env varlardan foydalanadi
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  await handleWebhook(req, res, getBot("b"));
}
