/**
 * discord-notify.ts - Discord notification module for Harvest Trading
 *
 * Sends messages to a configured Discord channel.
 * Converts Telegram-style Markdown to Discord-compatible Markdown.
 */

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Convert Telegram Markdown to Discord Markdown.
 * Telegram: *bold*  _italic_
 * Discord:  **bold**  *italic*
 */
function telegramToDiscord(text: string): string {
  let result = text;
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "**$1**");
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "*$1*");
  return result;
}

/**
 * Send a message to the configured Discord trading channel.
 * Handles Discord's 2000 char limit by splitting messages.
 *
 * Required env vars:
 *   DISCORD_BOT_TOKEN
 *   DISCORD_TRADING_CHANNEL_ID
 */
export async function sendDiscord(text: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_TRADING_CHANNEL_ID;

  if (!token || !channelId) {
    console.error("[Discord] Bot token or channel ID not configured (DISCORD_BOT_TOKEN, DISCORD_TRADING_CHANNEL_ID)");
    return;
  }

  const discordText = telegramToDiscord(text);

  const maxLen = 1990;
  const parts: string[] = [];

  if (discordText.length <= maxLen) {
    parts.push(discordText);
  } else {
    let current = "";
    for (const line of discordText.split("\n")) {
      if (current.length + line.length + 1 > maxLen) {
        if (current) parts.push(current);
        if (line.length > maxLen) {
          for (let i = 0; i < line.length; i += maxLen) {
            parts.push(line.slice(i, i + maxLen));
          }
          current = "";
        } else {
          current = line;
        }
      } else {
        current += (current ? "\n" : "") + line;
      }
    }
    if (current) parts.push(current);
  }

  for (const part of parts) {
    try {
      const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: part }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[Discord] API error: HTTP ${resp.status} - ${body}`);
      }
    } catch (e) {
      console.error(`[Discord] Send error: ${e}`);
    }
  }

  console.error("[Discord] Notification sent");
}
