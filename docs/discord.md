# Discord as a chat channel

An instance can take a Discord channel as a second front door to its **Assistant** conversation, the same one the web page shows. Each instance has its own bot and its own channel, and the channel has one human, the owner.

## How it behaves

- **Who it answers.** Only the owner's messages in that channel are run, and they are owner turns with the same tools, policy and storage as the web page. Messages from anyone else, from bots (itself included) and from other channels are ignored and never reach the model, as are edits, DMs and system messages. A message from someone else is logged with only the author's id.
- **Replies.** The reply posts as a Discord reply to your message. A long reply is split into ordered messages of at most 2,000 characters that, joined, are exactly the reply. Mentions in replies never ping anyone, and the channel shows "typing…" while a turn runs.
- **Order.** Turns run one at a time, in order. If the web page already has a reply running, the Discord message is refused with a note to send it again, never queued silently. The same happens in the other direction.
- **Confirmations stay on the web page.** A turn that makes proposals (a launch, a server operation, a protected vault write) says how many are waiting and links the page. Nothing can be confirmed from Discord.
- **Photos and files.** They aren't supported over Discord yet, and a message with only attachments gets a note saying so.

## Configuration

All three settings are needed:

| Setting | Where |
| --- | --- |
| Bot token | systemd credential `<persona id>.discord-bot`, at `/etc/credstore/<id>.discord-bot` (root, 0600). ORBIT's unit imports `orbit.*`; `deploy/install-instance.sh` gives other instances `ImportCredential=<id>.*`. |
| Channel | `persona.json` → `discord.channelId` (a string), or `ORBIT_DISCORD_CHANNEL` |
| Owner | `persona.json` → `discord.ownerUserId` (a string), or `ORBIT_DISCORD_OWNER` |

- **Nothing set:** Discord is off, has no port, and the `channel` line says it isn't configured.
- **Partly set or invalid:** the `discord` port is `down` with what's missing, so the watch reports it.
- **Discord refuses the token, or Message Content Intent is off (close 4014):** the port is `down` with the fix, and the bot does not retry until a restart.
- **A dropped connection** resumes the same session, backing off up to 60 s, and is `degraded` meanwhile.

## Creating the bot

1. In the Discord developer portal, create a **New Application**.
2. On the **Bot** tab:
   - Set the name and avatar.
   - Turn **Public Bot** off.
   - Turn **Message Content Intent** on.
   - **Reset Token** and copy the token.
3. In the **OAuth2 URL Generator**, choose scope `bot` with the permissions View Channels, Send Messages, Read Message History, Add Reactions and Attach Files. Open the URL to add the bot to the server, and add it to the channel if the channel is private.
4. On the host, run `sudo sh -c 'umask 077; cat > /etc/credstore/<id>.discord-bot'`, paste the token, then press Ctrl-D. Restart the service.

Only one process may use a bot token. Another program connected with the same token would also receive the owner's messages and answer them.

Implementation: `src/discord.ts`. It uses Gateway v10 over Node's built-in WebSocket and REST over fetch, with no dependency. Tests: `test/discord.test.ts`.
